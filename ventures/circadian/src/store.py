"""
Small persistent state for the consumer app: push subscriptions, WHOOP
tokens, and two secrets the server makes for itself.

One SQLite file in CIRCADIAN_DATA_DIR (circadian.sqlite3), one row per record:
a collection ("push", "whoop", "secrets"), a key (a device id), and the record
as JSON. On Railway that directory must be a mounted volume, or every redeploy
forgets who asked for reminders and who connected WHOOP; startup logs which it
is. SQLite because it is in Python's standard library and is a file on the
volume the founder already mounted: nothing new to run, back up or pay for.

It replaced one JSON file per collection, read and rewritten whole on every
change. That was fine for tens of travellers and measured badly past that
(docs: ventures/circadian/ARCHITECTURE.md): at 5,000 travellers the reminders
file was 46 MB, every switch-on rewrote all of it, and the minute tick's
check-in sweep, which asked "is WHOOP connected?" per device by re-reading the
whole WHOOP file, took 43 seconds, so reminders due in the same minute were
late. A record is now read and written on its own.

Two ways in, on purpose:

- get / put / delete / update_record / items: one record at a time. What the
  hot paths use.
- read / write / update: a whole collection as a dict, as before. Kept so
  code and tests that think in collections work unchanged; write replaces
  the collection in one transaction.

Writes are serialised by one lock and each is a transaction, so a crash
mid-write leaves the previous record rather than half of a new one (the
property the JSON files got from temp-file-and-rename).

The first time a collection is used in a directory that still has its old
<name>.json, the file is imported in one transaction and renamed to
<name>.json.imported, which is kept: it is the backup until the database has
been through a redeploy.

The secrets are generated on first use and kept here too: the HMAC key that
signs the WHOOP OAuth state, and the VAPID key pair web push is signed with.
Generating them here is what lets the founder deploy without running a
command to make keys; keeping them is what keeps existing subscriptions valid
across restarts.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

_LOCK = threading.RLock()
DB_NAME = "circadian.sqlite3"
_connections: Dict[str, sqlite3.Connection] = {}
_imported: set = set()
_on_commit: List[Callable[[], None]] = []     # run once the outermost transaction commits
_on_rollback: List[Callable[[], None]] = []   # or instead, if it rolls back


def data_dir() -> Path:
    configured = os.environ.get("CIRCADIAN_DATA_DIR", "").strip()
    path = Path(configured) if configured else Path(__file__).resolve().parent.parent / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def describe_storage() -> str:
    if os.environ.get("CIRCADIAN_DATA_DIR", "").strip():
        return f"CircadianAPI: storing reminders and WHOOP connections in {data_dir() / DB_NAME}."
    return (
        "CircadianAPI: CIRCADIAN_DATA_DIR is not set, so reminders and WHOOP connections are kept "
        "inside the container and lost on every redeploy. Mount a volume and point it there."
    )


def _db() -> sqlite3.Connection:
    """One connection per data directory, shared by the server's threads under _LOCK."""
    directory = data_dir()
    key = str(directory)
    conn = _connections.get(key)
    if conn is None:
        conn = sqlite3.connect(directory / DB_NAME, check_same_thread=False, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")      # readers never wait on the writer
        conn.execute("PRAGMA synchronous=NORMAL")    # durable at each checkpoint; safe with WAL
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("CREATE TABLE IF NOT EXISTS records ("
                     " collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,"
                     " PRIMARY KEY (collection, key)) WITHOUT ROWID")
        _connections[key] = conn
    return conn


def _import_json(name: str) -> None:
    """The old <name>.json, once, into the database; the file is renamed and kept."""
    marker = (str(data_dir()), name)
    if marker in _imported:
        return
    _imported.add(marker)
    old = data_dir() / f"{name}.json"
    if not old.exists():
        return
    conn = _db()
    if conn.execute("SELECT 1 FROM records WHERE collection = ? LIMIT 1", (name,)).fetchone():
        return   # already has rows: the file is older than the database, leave it be
    try:
        value = json.loads(old.read_text())
    except (OSError, ValueError):
        print(f"CircadianAPI: {old} could not be read, so it was not imported; it is left in place.")
        return
    if not isinstance(value, dict):
        print(f"CircadianAPI: {old} is not a collection of records, so it was not imported; it is left in place.")
        return

    def renamed():
        old.rename(old.with_name(old.name + ".imported"))
        print(f"CircadianAPI: imported {len(value)} {name} records from {old.name} (kept as {old.name}.imported).")

    # The file is renamed only once the rows are committed. The import can run
    # inside a caller's transaction (the first use of a collection may be in
    # one); if that rolls back, the rows go, the file stays, and the next use
    # imports it again rather than finding neither.
    _on_commit.append(renamed)
    _on_rollback.append(lambda: _imported.discard(marker))
    with _transaction(conn):
        conn.executemany("INSERT INTO records (collection, key, value) VALUES (?, ?, ?)",
                         [(name, str(k), json.dumps(v)) for k, v in value.items()])


class _transaction:
    """BEGIN/COMMIT, or nothing when already inside one: the outermost decides."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.outer = False

    def __enter__(self):
        self.outer = not self.conn.in_transaction
        if self.outer:
            self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, kind, _value, _tb):
        if not self.outer:
            return False
        self.conn.execute("ROLLBACK" if kind else "COMMIT")
        callbacks = _on_rollback if kind else _on_commit
        pending = list(callbacks)
        _on_commit.clear()
        _on_rollback.clear()
        for fn in pending:
            fn()
        return False


@contextmanager
def transaction():
    """
    Several record operations as one: all of them land, or none do, and no
    other thread sees the state in between.
    """
    with _LOCK:
        with _transaction(_db()):
            yield


# --- one record at a time -----------------------------------------------------------------

def get(name: str, key: str, default: Any = None) -> Any:
    with _LOCK:
        _import_json(name)
        row = _db().execute("SELECT value FROM records WHERE collection = ? AND key = ?", (name, str(key))).fetchone()
    return json.loads(row[0]) if row else default


def put(name: str, key: str, value: Any) -> None:
    with _LOCK:
        _import_json(name)
        conn = _db()
        with _transaction(conn):
            conn.execute("INSERT INTO records (collection, key, value) VALUES (?, ?, ?) "
                         "ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value",
                         (name, str(key), json.dumps(value)))


def delete(name: str, key: str) -> bool:
    """True when there was a record to delete."""
    with _LOCK:
        _import_json(name)
        conn = _db()
        with _transaction(conn):
            return conn.execute("DELETE FROM records WHERE collection = ? AND key = ?", (name, str(key))).rowcount > 0


def update_record(name: str, key: str, change: Callable[[Optional[Any]], Optional[Any]]) -> Optional[Any]:
    """
    Read one record, change it, write it back, under the lock. `change` gets the
    record or None and returns the new record, or None to delete it.
    """
    with _LOCK:
        current = get(name, key)
        new = change(current)
        if new is None:
            if current is not None:
                delete(name, key)
        else:
            put(name, key, new)
        return new


def items(name: str) -> List[Tuple[str, Any]]:
    """Every record of a collection, as (key, record) pairs, in key order."""
    with _LOCK:
        _import_json(name)
        rows = _db().execute("SELECT key, value FROM records WHERE collection = ? ORDER BY key", (name,)).fetchall()
    return [(k, json.loads(v)) for k, v in rows]


# --- a whole collection, as before ---------------------------------------------------------

def read(name: str, default: Any) -> Any:
    rows = items(name)
    return {k: v for k, v in rows} if rows else default


def write(name: str, value: Dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise TypeError(f"a {name} collection is a dict of records, not {type(value).__name__}")
    with _LOCK:
        _import_json(name)
        conn = _db()
        with _transaction(conn):
            conn.execute("DELETE FROM records WHERE collection = ?", (name,))
            conn.executemany("INSERT INTO records (collection, key, value) VALUES (?, ?, ?)",
                             [(name, str(k), json.dumps(v)) for k, v in value.items()])


def update(name: str, default: Any, change) -> Any:
    """Read, change, write, under the lock; returns the new value."""
    with _LOCK:
        value = read(name, default)
        value = change(value)
        write(name, value)
        return value


# --- the server's own secrets ----------------------------------------------------------------

def server_secret() -> bytes:
    """A 32-byte key for signing things this server hands out and gets back."""
    with _LOCK:
        secrets_file = read("secrets", {})
        if "hmac" not in secrets_file:
            secrets_file["hmac"] = base64.b64encode(secrets.token_bytes(32)).decode()
            write("secrets", secrets_file)
        return base64.b64decode(secrets_file["hmac"])


def vapid_keys() -> dict:
    """
    {'private_pem': str, 'public_key': str}: the web-push signing pair.
    public_key is the base64url uncompressed P-256 point the browser needs.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    with _LOCK:
        secrets_file = read("secrets", {})
        if "vapid_private_pem" not in secrets_file:
            key = ec.generate_private_key(ec.SECP256R1())
            secrets_file["vapid_private_pem"] = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode()
            write("secrets", secrets_file)
        key = serialization.load_pem_private_key(secrets_file["vapid_private_pem"].encode(), password=None)
        raw = key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return {
            "private_pem": secrets_file["vapid_private_pem"],
            "public_key": base64.urlsafe_b64encode(raw).rstrip(b"=").decode(),
        }
