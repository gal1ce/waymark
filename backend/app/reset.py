"""Starting over, and deleting the account.

Start over: the plan and everything done under it go (days, tasks, tests, scores, notes, the coach's conversations,
sticking points); who the user is and how the app is set up stay (name, picture, GitHub choice, the coach's settings,
picture and memory notes, the AI providers and their keys). The app then opens on plan setup. A backup file of
everything as it was is written to backups/ first, so Settings → Data → Restore brings it all back.

Delete the account: everything the app recorded in the data folder goes, automatic backups included, and the app is
as on the day it was installed. The AI keys in .env go too when the user asks. Not touched: the app itself, Khan
content downloaded through Kolibri, and the CTU plan's own files outside the data folder (the study repo, COACH.md),
which are the user's.

Both swap in a new database the way a restore does (app/backup.py): built aside, then renamed over the old one while
nothing else can use the connection."""
from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

from . import account, backup, coach, db, envfile, notes, planlog, profile, providers, state
from .config import DATA_DIR, DB_PATH, now

# settings kept by a start over (kv keys); everything else in kv belongs to the plan or to its days
KEEP_KV = ("ai_settings", "coach_settings", "coach_avatar", "coach_protected", "update_check_on", "update_skipped",
           "last_language")


def _fresh(stage: Path, keep: bool) -> Path:
    """A new database as a new install has it (no plan: preset 'none'), with the account and settings copied over
    when `keep`."""
    out = stage / "ctu.db"
    c = sqlite3.connect(out, isolation_level=None)
    try:
        c.executescript(db.SCHEMA)
        db._migrate(c)
        if keep:
            p = db.q1("SELECT name, photo, github, created_at FROM profile WHERE id=1")
            if p:
                c.execute("UPDATE profile SET name=?, photo=?, github=?, created_at=?, updated_at=? WHERE id=1",
                          (p["name"], p["photo"], p["github"], p["created_at"], db.ts()))
            for k in KEEP_KV:
                r = db.q1("SELECT value FROM kv WHERE key=?", (k,))
                if r:
                    c.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (k, r["value"]))
            for r in db.q("SELECT text, created_at, updated_at FROM coach_memory ORDER BY id"):
                c.execute("INSERT INTO coach_memory (text, created_at, updated_at) VALUES (?, ?, ?)",
                          (r["text"], r["created_at"], r["updated_at"]))
    finally:
        c.close()
    return out


def _swap(new_db: Path) -> None:
    with db._lock:
        if db._tx_depth:
            raise RuntimeError("reset inside a transaction")
        backup._check_idle()
        if db._conn is not None:
            db._conn.close()
            db._conn = None
        os.replace(new_db, DB_PATH)
        for suffix in ("-wal", "-shm"):
            Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
        db.conn()
        profile.reload()


def _remove(*paths: Path) -> None:
    for p in paths:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


def _forget_runtime() -> None:
    """What this run of the server remembers about keys and models (the database no longer backs it)."""
    from . import llm
    providers._health.clear()
    providers._last.clear()
    llm._clients.clear()
    llm._catalogs.clear()


def start_over() -> dict:
    backup._check_idle()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state.pause_all("start over")   # the backup below then has the running task's time in it
    db.backup_dir().mkdir(parents=True, exist_ok=True)
    kept = backup.export(db.backup_dir() / f"waymark-before-start-over-{now().strftime('%Y-%m-%dT%H%M%S')}.zip")
    stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=DATA_DIR))   # same disk, so the swap is a rename
    try:
        _swap(_fresh(stage, keep=True))
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    _remove(notes.assets_dir(), planlog.path())
    return {"kept": str(kept)}


def key_names() -> list[str]:
    """The .env variables that hold AI keys (both spellings of each)."""
    return [n for p in providers.PROVIDERS.values() if p.env for n in (p.env, p.env.removesuffix("S"))]


def delete_account(keys: bool) -> dict:
    backup._check_idle()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state.pause_all("delete account")
    stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=DATA_DIR))
    try:
        _swap(_fresh(stage, keep=False))
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    _remove(notes.assets_dir(), coach.avatar_dir(), account.photo_dir(), db.backup_dir(), planlog.path(),
            DATA_DIR / ".transfer")
    removed = 0
    if keys:
        for name in key_names():
            if envfile.get(name):
                removed += len(envfile.split(envfile.get(name)))
                envfile.set_list(name, [])
        if envfile.get("ANTHROPIC_WORKSPACE_ID"):
            envfile.set_list("ANTHROPIC_WORKSPACE_ID", [])
    _forget_runtime()
    return {"keys_removed": removed}
