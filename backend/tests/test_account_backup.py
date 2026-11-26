"""The local account and the backup file: where an install keeps its data, who it belongs to, and moving all of it
to another computer and back without losing a picture."""
from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import account, backup, config, db, main, notes, profile, state

H = {"x-ctu": "1"}
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


@pytest.fixture
def client(seeded):
    return TestClient(main.app, base_url="http://127.0.0.1:8723")


# ------------------------------------------------------------------ data folder
def test_data_folder_is_outside_the_app(tmp_path):
    home, legacy = tmp_path / "home", tmp_path / "app" / "backend" / "data" / "ctu.db"
    assert config.data_dir_for({}, home, legacy, windows=False) == home / ".local" / "share" / "waymark"
    assert config.data_dir_for({"XDG_DATA_HOME": str(tmp_path / "x")}, home, legacy, windows=False) == tmp_path / "x" / "waymark"
    assert config.data_dir_for({"APPDATA": str(tmp_path / "roam")}, home, legacy, windows=True) == tmp_path / "roam" / "Waymark"
    assert config.data_dir_for({"CTU_DATA_DIR": str(tmp_path / "mine")}, home, legacy, windows=False) == tmp_path / "mine"


def test_an_existing_install_keeps_its_database_where_it_is(tmp_path):
    home, legacy = tmp_path / "home", tmp_path / "app" / "backend" / "data" / "ctu.db"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"")
    assert config.data_dir_for({}, home, legacy, windows=False) == legacy.parent
    # an explicit folder still wins
    assert config.data_dir_for({"CTU_DATA_DIR": str(tmp_path / "mine")}, home, legacy, windows=False) == tmp_path / "mine"


# ------------------------------------------------------------------ account
def _close_db() -> None:
    """Forget the database the fixture opened, so a test can put an older one in its place."""
    with db._lock:
        if db._conn is not None:
            db._conn.close()
        db._conn = None
    for suffix in ("", "-wal", "-shm"):
        Path(str(config.DB_PATH) + suffix).unlink(missing_ok=True)
    profile.reload()


def test_an_existing_install_becomes_the_ctu_user_with_github_on(fresh):
    """The user's own database (schema v9, days in it) upgrades to an account that shows their GitHub as before."""
    path = config.DB_PATH
    _close_db()
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript(db.SCHEMA)
    c.execute("INSERT INTO days (date, week, created_at) VALUES ('2026-11-23', 0, '2026-11-22T10:00:00')")
    c.execute("PRAGMA user_version=9")
    c.commit()
    c.close()
    me = account.get()
    assert me["preset"] == "ctu" and me["github"] == "on" and me["name"] == ""
    assert db.q1("SELECT COUNT(*) AS n FROM days")["n"] == 1


def test_a_new_install_is_asked_about_github_and_has_no_plan(fresh):
    _close_db()
    assert account.get()["github"] is None
    assert profile.key() is None and not profile.ready()


def test_name_photo_and_github_choice(client):
    assert client.put("/api/me", json={"name": "  Ada   Lovelace "}, headers=H).json()["name"] == "Ada Lovelace"
    assert client.put("/api/me", json={"name": "x" * 61}, headers=H).status_code == 409
    me = client.post("/api/me/photo", content=PNG, headers=H | {"content-type": "image/png"}).json()
    assert client.get(me["photo"]).content == PNG
    assert client.post("/api/me/photo", content=b"<svg/>", headers=H | {"content-type": "image/svg+xml"}).status_code == 409
    assert client.put("/api/me/github", json={"github": "off"}, headers=H).json()["github"] == "off"
    assert client.put("/api/me/github", json={"github": "maybe"}, headers=H).status_code == 409
    prof = client.get("/api/profile").json()
    assert prof["me"]["name"] == "Ada Lovelace" and prof["github"] is None
    old = Path(account.photo_dir() / me["photo"].rsplit("/", 1)[1])
    client.delete("/api/me/photo", headers=H)
    assert not old.exists() and account.get()["photo"] is None
    assert client.put("/api/me", json={"name": "x"}).status_code == 403   # no X-CTU header


# ------------------------------------------------------------------ backup file
def _export(client) -> bytes:
    r = client.post("/api/backup/export", headers=H)
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert "waymark-backup-" in r.headers["content-disposition"]
    return r.content


def _restore(client, data: bytes):
    return client.post("/api/backup/restore", content=data, headers=H | {"content-type": "application/zip"})


def test_export_then_restore_brings_everything_back(client):
    account.save_name("Ada")
    account.save_photo(PNG, "image/png")
    page = notes.create("Vectors", "doc")
    pic = notes.save_asset(PNG + b"note", "image/png")
    data = _export(client)
    names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
    assert {"manifest.json", backup.DB_ENTRY, f"notes/{pic}"} <= names and any(n.startswith("me/photo-") for n in names)
    assert not any(n.endswith(".env") or "backups/" in n for n in names)

    # the user deletes things after the backup
    account.save_name("Somebody else")
    account.clear_photo()
    notes.delete(page["id"])
    (notes.assets_dir() / pic).unlink()

    r = _restore(client, data)
    assert r.status_code == 200, r.text
    assert account.get()["name"] == "Ada" and account.get()["photo"]
    assert db.q1("SELECT title FROM notes_pages WHERE id=?", (page["id"],))["title"] == "Vectors"
    assert (notes.assets_dir() / pic).read_bytes() == PNG + b"note"
    # what was here before the restore is kept
    assert Path(r.json()["kept"]).is_file()
    assert list(db.backup_dir().glob("files-before-restore-*"))
    assert db.schema_version() == len(db.MIGRATIONS)
    assert not (config.DATA_DIR / ".transfer").exists() or not any((config.DATA_DIR / ".transfer").iterdir())


def _zip(entries: dict[str, bytes], manifest: dict | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("manifest.json", json.dumps(manifest or {"format": backup.FORMAT, "version": 1}))
        for k, v in entries.items():
            z.writestr(k, v)
    return buf.getvalue()


def _good_db(tmp_path: Path, version: int | None = None, day: bool = False) -> bytes:
    p = tmp_path / "x.db"
    c = sqlite3.connect(p)
    c.executescript(db.SCHEMA)
    if day:
        c.execute("INSERT INTO days (date, week, created_at) VALUES ('2026-11-23', 0, '2026-11-22T10:00:00')")
    c.execute(f"PRAGMA user_version={version if version is not None else len(db.MIGRATIONS)}")
    c.commit()
    c.close()
    return p.read_bytes()


@pytest.mark.parametrize("bad", ["../evil.png", "notes/../../evil.png", "/etc/passwd", "notes/x.svg", ".env", "me/photo.png"])
def test_restore_refuses_files_it_did_not_make(client, tmp_path, bad):
    before = db.q1("SELECT COUNT(*) AS n FROM tasks")["n"]
    r = _restore(client, _zip({backup.DB_ENTRY: _good_db(tmp_path), bad: b"x"}))
    assert r.status_code == 409 and "doesn't make" in r.json()["error"]
    assert db.q1("SELECT COUNT(*) AS n FROM tasks")["n"] == before
    assert not (tmp_path.parent / "evil.png").exists()


def test_restore_refuses_what_is_not_a_backup(client, tmp_path):
    assert _restore(client, b"not a zip").status_code == 409
    assert _restore(client, _zip({}, {"format": backup.FORMAT, "version": 1})).status_code == 409
    assert _restore(client, _zip({backup.DB_ENTRY: _good_db(tmp_path)}, {"format": "other"})).status_code == 409
    assert _restore(client, _zip({backup.DB_ENTRY: b"garbage" * 100})).status_code == 409
    newer = _restore(client, _zip({backup.DB_ENTRY: _good_db(tmp_path, len(db.MIGRATIONS) + 1)}))
    assert newer.status_code == 409 and "newer version" in newer.json()["error"]


def test_restore_pauses_a_running_task_and_keeps_its_time(client):
    tid = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' LIMIT 1")["id"]
    data = _export(client)
    state.start_task(tid)
    r = _restore(client, data)
    assert r.status_code == 200, r.text
    kept = sqlite3.connect(r.json()["kept"])
    assert kept.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0] == "todo"
    kept.close()
    assert not db.q1("SELECT 1 FROM tasks WHERE status='doing'")


def test_restore_waits_for_a_test_being_written(client, monkeypatch):
    from app import tests_eod
    data = _export(client)
    monkeypatch.setitem(tests_eod._LIVE, 99, {"stage": "writing"})
    r = _restore(client, data)
    assert r.status_code == 409 and "being written" in r.json()["error"]


def test_restore_of_an_older_backup_is_upgraded(client, tmp_path):
    r = _restore(client, _zip({backup.DB_ENTRY: _good_db(tmp_path, 9, day=True)}))
    assert r.status_code == 200, r.text
    assert db.schema_version() == len(db.MIGRATIONS)
    assert account.get()["preset"] == "ctu" and profile.is_ctu()


def test_restore_switches_to_the_backups_plan(client, tmp_path):
    """A backup from a new install (no plan yet) replaces a CTU install: the app follows the restored database."""
    assert profile.is_ctu()
    r = _restore(client, _zip({backup.DB_ENTRY: _good_db(tmp_path, 9)}))
    assert r.status_code == 200, r.text
    assert profile.key() is None and not profile.ready()


# ------------------------------------------------------------------ starting over and deleting the account
def _set_up(client):
    """An install in use: a name, a picture, a coach memory, AI settings, a notebook picture and days."""
    from app import providers
    client.put("/api/me", json={"name": "Ada"}, headers=H)
    client.post("/api/me/photo", content=PNG, headers=H | {"content-type": "image/png"})
    db.ex("INSERT INTO coach_memory (text, created_at, updated_at) VALUES ('Likes proofs.', 'x', 'x')")
    providers.save_settings(fallback=True)
    db.kv_set("cursor", {"unit": 3})
    notes.assets_dir().mkdir(parents=True, exist_ok=True)
    (notes.assets_dir() / ("a" * 24 + ".png")).write_bytes(PNG)
    assert db.q1("SELECT COUNT(*) AS n FROM days")["n"] > 0


def test_starting_over_keeps_the_account_and_settings_and_drops_the_plan(client):
    from app import providers
    _set_up(client)
    client.put("/api/me/github", json={"github": "off"}, headers=H)
    assert client.post("/api/account/start-over", json={}, headers=H).status_code == 409   # not confirmed
    out = client.post("/api/account/start-over", json={"confirm": True}, headers=H).json()
    me = account.get()
    assert me["name"] == "Ada" and me["photo"] and me["preset"] == "none" and me["github"] == "off"
    assert not profile.ready()
    assert db.q1("SELECT COUNT(*) AS n FROM days")["n"] == 0 and db.kv_get("cursor") is None
    assert [r["text"] for r in db.q("SELECT text FROM coach_memory")] == ["Likes proofs."]
    assert providers.settings()["fallback"] is True
    assert not notes.assets_dir().exists()
    # the backup file written first holds the plan: restoring it brings the days back
    kept = Path(out["kept"])
    assert kept.is_file() and kept.parent == db.backup_dir()
    with zipfile.ZipFile(kept) as z:
        assert "notes/" + "a" * 24 + ".png" in z.namelist()
    backup.restore(kept)
    assert db.q1("SELECT COUNT(*) AS n FROM days")["n"] > 0


def test_deleting_the_account_leaves_a_new_install_and_can_take_the_keys(client, monkeypatch, tmp_path):
    from app import envfile, providers
    env = tmp_path / ".env"
    env.write_text("# mine\nSTUDY=1\nGROQ_API_KEYS=gsk_" + "g" * 40 + "\n")
    monkeypatch.setenv("CTU_ENV_FILE", str(env))
    envfile._cache = None
    _set_up(client)
    db.backup("by-hand")
    assert client.post("/api/account/delete", json={"keys": True}, headers=H).status_code == 409
    out = client.post("/api/account/delete", json={"confirm": True, "keys": True}, headers=H).json()
    assert out["keys_removed"] == 1
    me = account.get()
    assert me["name"] == "" and me["photo"] is None and me["github"] is None and me["preset"] == "none"
    assert db.q1("SELECT COUNT(*) AS n FROM coach_memory")["n"] == 0 and db.q1("SELECT COUNT(*) AS n FROM days")["n"] == 0
    assert providers.settings()["fallback"] is False
    assert not account.photo_dir().exists() and not notes.assets_dir().exists() and not db.backup_dir().exists()
    assert env.read_text() == "# mine\nSTUDY=1\n" and providers.keys("groq") == []
    envfile._cache = None


def test_deleting_the_account_keeps_the_keys_unless_asked(client, monkeypatch, tmp_path):
    from app import envfile, providers
    env = tmp_path / ".env"
    env.write_text("GROQ_API_KEYS=gsk_" + "g" * 40 + "\n")
    monkeypatch.setenv("CTU_ENV_FILE", str(env))
    envfile._cache = None
    assert client.post("/api/account/delete", json={"confirm": True}, headers=H).json()["keys_removed"] == 0
    assert len(providers.keys("groq")) == 1
    envfile._cache = None
