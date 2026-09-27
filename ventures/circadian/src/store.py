"""
Small persistent state for the consumer app: push subscriptions, WHOOP
tokens, and two secrets the server makes for itself.

A JSON file per collection in CIRCADIAN_DATA_DIR. On Railway that directory
must be a mounted volume, or every redeploy forgets who asked for reminders and
who connected WHOOP; startup logs which it is. JSON rather than a database
because the volume is the only moving part the founder has to set up, and the
data is a few kilobytes per traveller.

Writes are atomic (temp file, then rename) and serialised by one lock, so a
crash mid-write leaves the previous file rather than half of a new one.

The secrets are generated on first use and kept in the same directory: the
HMAC key that signs the WHOOP OAuth state, and the VAPID key pair web push is
signed with. Generating them here is what lets the founder deploy without
running a command to make keys; keeping them is what keeps existing
subscriptions valid across restarts.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.RLock()


def data_dir() -> Path:
    configured = os.environ.get("CIRCADIAN_DATA_DIR", "").strip()
    path = Path(configured) if configured else Path(__file__).resolve().parent.parent / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def describe_storage() -> str:
    if os.environ.get("CIRCADIAN_DATA_DIR", "").strip():
        return f"CircadianAPI: storing reminders and WHOOP connections in {data_dir()}."
    return (
        "CircadianAPI: CIRCADIAN_DATA_DIR is not set, so reminders and WHOOP connections are kept "
        "inside the container and lost on every redeploy. Mount a volume and point it there."
    )


def read(name: str, default: Any) -> Any:
    with _LOCK:
        path = data_dir() / f"{name}.json"
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return default


def write(name: str, value: Any) -> None:
    with _LOCK:
        target = data_dir() / f"{name}.json"
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(value, fh)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def update(name: str, default: Any, change) -> Any:
    """Read, change, write, under the lock; returns the new value."""
    with _LOCK:
        value = read(name, default)
        value = change(value)
        write(name, value)
        return value


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
