"""
Tests for src/store.py, the SQLite record store, and the WHOOP member index.

Pinned because each failure here loses a traveller's data without an error:
the first deploy must carry the old JSON files over exactly once, a failed
change must leave the previous record rather than half of the new one, and
writers on different threads must not overwrite each other.
"""

import json
import threading

import pytest

from src import store, whoop


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    yield tmp_path


def test_one_record_at_a_time():
    assert store.get("push", "d1") is None and store.get("push", "d1", {}) == {}
    store.put("push", "d1", {"n": 1})
    store.put("push", "d2", {"n": 2})
    assert store.get("push", "d1") == {"n": 1}
    assert store.items("push") == [("d1", {"n": 1}), ("d2", {"n": 2})]
    assert store.update_record("push", "d1", lambda r: {"n": r["n"] + 1}) == {"n": 2}
    assert store.update_record("push", "d2", lambda r: None) is None, "None deletes"
    assert store.delete("push", "d1") is True and store.delete("push", "d1") is False
    assert store.read("push", "empty") == "empty"
    # Collections are separate.
    store.put("whoop", "d1", {"t": 1})
    assert store.get("push", "d1") is None


def test_a_collection_is_still_readable_and_writable_whole():
    store.write("push", {"a": 1, "b": 2})
    store.write("push", {"b": 3})
    assert store.read("push", {}) == {"b": 3}, "write replaces the collection"
    assert store.update("push", {}, lambda all_: {**all_, "c": 4}) == {"b": 3, "c": 4}
    with pytest.raises(TypeError):
        store.write("push", [1, 2])


def test_the_old_json_file_is_imported_once_and_kept(data_dir):
    (data_dir / "push.json").write_text(json.dumps({"d1": {"trip": 1}, "d2": {"trip": 2}}))
    assert store.get("push", "d2") == {"trip": 2}
    assert not (data_dir / "push.json").exists()
    assert json.loads((data_dir / "push.json.imported").read_text())["d1"] == {"trip": 1}
    # A stale file that reappears (say, restored by hand) is not imported over newer rows.
    store.put("push", "d1", {"trip": "new"})
    (data_dir / "push.json").write_text(json.dumps({"d1": {"trip": "old"}}))
    store._imported.clear()
    assert store.get("push", "d1") == {"trip": "new"}


def test_an_unreadable_old_file_is_left_in_place(data_dir, capsys):
    (data_dir / "whoop.json").write_text("{not json")
    assert store.items("whoop") == []
    assert (data_dir / "whoop.json").exists()
    assert "could not be read" in capsys.readouterr().out


def test_a_failed_change_leaves_every_record_as_it_was(data_dir):
    store.put("push", "a", 1)
    with pytest.raises(RuntimeError):
        with store.transaction():
            store.put("push", "a", 2)
            store.put("push", "b", 2)
            raise RuntimeError("crash mid-change")
    assert store.items("push") == [("a", 1)]
    with pytest.raises(RuntimeError):
        store.update_record("push", "a", lambda r: (_ for _ in ()).throw(RuntimeError()))
    assert store.get("push", "a") == 1


def test_an_import_inside_a_rolled_back_change_is_tried_again(data_dir):
    # The first use of a collection can be inside a transaction. If that one
    # rolls back, the imported rows go with it, so the file must stay.
    (data_dir / "whoop.json").write_text(json.dumps({"d1": {"access_token": "t"}}))
    with pytest.raises(RuntimeError):
        with store.transaction():
            assert store.get("whoop", "d1") == {"access_token": "t"}
            raise RuntimeError()
    assert (data_dir / "whoop.json").exists()
    assert store.get("whoop", "d1") == {"access_token": "t"}
    assert (data_dir / "whoop.json.imported").exists()


def test_writers_on_many_threads_do_not_lose_each_others_changes():
    store.put("push", "shared", 0)

    def bump():
        for _ in range(50):
            store.update_record("push", "shared", lambda n: n + 1)
            store.update_record("push", threading.current_thread().name, lambda n: (n or 0) + 1)

    threads = [threading.Thread(target=bump, name=f"t{i}") for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert store.get("push", "shared") == 400
    assert [store.get("push", f"t{i}") for i in range(8)] == [50] * 8


# --- the WHOOP member index -----------------------------------------------------------------

def test_the_webhook_finds_a_member_by_the_index_and_forgets_them_on_disconnect():
    store.put(whoop.COLLECTION, "dev-1", {"access_token": "a", "expires_at": 0})
    whoop._remember_user_id("dev-1", [{"user_id": 10129}])
    assert store.get(whoop.USERS, "10129") == "dev-1"
    assert whoop.device_for_user(10129) == "dev-1"
    whoop._forget("dev-1")
    assert store.get(whoop.USERS, "10129") is None
    assert whoop.device_for_user(10129) is None


def test_a_member_connected_before_the_index_is_found_once_by_a_scan_then_indexed():
    store.put(whoop.COLLECTION, "dev-old", {"access_token": "a", "user_id": 777})
    assert store.get(whoop.USERS, "777") is None
    assert whoop.device_for_user(777) == "dev-old"
    assert store.get(whoop.USERS, "777") == "dev-old"
    assert whoop.device_for_user(None) is None and whoop.device_for_user(1) is None


def test_an_index_entry_that_no_longer_matches_is_not_trusted():
    # The device reconnected as a different WHOOP member: the old id must not reach it.
    store.put(whoop.COLLECTION, "dev-1", {"access_token": "a", "user_id": 2})
    store.put(whoop.USERS, "1", "dev-1")
    assert whoop.device_for_user(1) is None


def test_refreshing_tokens_keeps_the_member_id():
    store.put(whoop.COLLECTION, "dev-1", {"access_token": "a", "refresh_token": "r", "user_id": 5})
    whoop._save_tokens("dev-1", {"access_token": "b", "expires_in": 3600}, now=0)
    assert store.get(whoop.COLLECTION, "dev-1") == {"access_token": "b", "refresh_token": "r", "user_id": 5,
                                                     "expires_at": 3540}
