"""A whole install in one file, and back: the database with every notebook picture, the coach's picture and the user's
picture. Moving to another computer or reinstalling the app is export here, restore there.

What is not in it: the API key (it lives in .env, never in the data folder), Kolibri's Khan content (downloaded again
with ./setup-khan.sh) and the study repo (it is the user's own folder, usually in git)."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from . import account, coach, db, notes, profile, state
from .config import DATA_DIR, DB_PATH, now

FORMAT = "waymark-backup"
VERSION = 1
DB_ENTRY = "waymark.db"
MAX_TOTAL = 2 * 1024 ** 3       # bytes, everything in the file unpacked
MAX_UPLOAD = 2 * 1024 ** 3      # bytes, the file itself
KEEP_FILE_COPIES = 3            # folders of pictures kept from before a restore


def _folders() -> dict[str, tuple[Path, object]]:
    """Folder name in the backup → (folder in the data folder, the file names it may hold)."""
    return {"notes": (notes.assets_dir(), notes._NAME), "coach": (coach.avatar_dir(), coach._AVATAR),
            "me": (account.photo_dir(), account.PHOTO_NAME)}


def file_name() -> str:
    return f"waymark-backup-{now().strftime('%Y-%m-%d-%H%M')}.zip"


def export(out: Path) -> Path:
    """Writes the backup to `out`. The database copy is consistent (VACUUM INTO includes what is still in the WAL)."""
    tmp_db = out.with_name(out.name + ".db")
    tmp_db.unlink(missing_ok=True)
    with db._lock:
        if db._tx_depth:
            raise RuntimeError("export inside a transaction")
        db.conn().execute("VACUUM INTO ?", (str(tmp_db),))
        version = db.schema_version()
    try:
        manifest = {"format": FORMAT, "version": VERSION, "schema": version,
                    "created": now().isoformat(timespec="seconds"), "preset": account.get()["preset"]}
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", json.dumps(manifest, indent=1))
            z.write(tmp_db, DB_ENTRY)
            for name, (folder, allowed) in _folders().items():
                if not folder.is_dir():
                    continue
                for f in sorted(folder.iterdir()):
                    if f.is_file() and allowed.fullmatch(f.name):
                        # pictures are compressed already
                        z.write(f, f"{name}/{f.name}", compress_type=zipfile.ZIP_STORED)
    finally:
        tmp_db.unlink(missing_ok=True)
    return out


def cleanup() -> None:
    """Leftovers of an export or restore the server was stopped in the middle of."""
    for p in [DATA_DIR / ".transfer", *DATA_DIR.glob(".restore-*")]:
        shutil.rmtree(p, ignore_errors=True)


def _check_idle() -> None:
    """Work the app is doing in the background would write into the database being swapped out, so a restore waits for
    it. An open test or a running timer is only data: it is kept in the copy made first, like everything else."""
    from . import agent, planner, tests_eod
    if tests_eod._LIVE or any(not t.done() for t in agent._fills.values()):
        raise state.Refused("A test is being written right now. Try again when it is ready.")
    if planner._lock.locked():
        raise state.Refused("The app is planning days right now. Try again in a minute.")


def _read_db(p: Path) -> int:
    """Checks the database in a backup; returns its schema version."""
    try:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        try:
            ok = c.execute("PRAGMA integrity_check").fetchone()[0]
            version = c.execute("PRAGMA user_version").fetchone()[0]
            has_days = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='days'").fetchone()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        raise state.Refused("The database in this backup can't be read.") from None
    if ok != "ok" or not has_days:
        raise state.Refused("The database in this backup is damaged.")
    if version > len(db.MIGRATIONS):
        raise state.Refused("This backup was made by a newer version of Waymark. Update the app first.")
    return version


def _unpack(src: Path, stage: Path) -> dict:
    folders = _folders()
    try:
        z = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError):
        raise state.Refused("This isn't a Waymark backup (not a zip file).") from None
    with z:
        infos = z.infolist()
        names = {i.filename for i in infos}
        if "manifest.json" not in names or DB_ENTRY not in names:
            raise state.Refused("This isn't a Waymark backup.")
        try:
            manifest = json.loads(z.read("manifest.json"))
        except ValueError:
            raise state.Refused("This isn't a Waymark backup (its manifest can't be read).") from None
        if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
            raise state.Refused("This isn't a Waymark backup.")
        if not isinstance(manifest.get("version"), int) or manifest["version"] > VERSION:
            raise state.Refused("This backup was made by a newer version of Waymark. Update the app first.")
        if sum(i.file_size for i in infos) > MAX_TOTAL:
            raise state.Refused("This backup is too large to restore.")
        # every entry must be one we write; nothing is ever unpacked to a path taken from the file
        plan: list[tuple[zipfile.ZipInfo, Path]] = []
        for i in infos:
            n = i.filename
            if n == "manifest.json":
                continue
            if n == DB_ENTRY:
                plan.append((i, stage / "ctu.db"))
                continue
            if i.is_dir() and n.rstrip("/") in folders:
                continue
            folder, _, f = n.partition("/")
            if folder not in folders or not folders[folder][1].fullmatch(f):
                raise state.Refused(f"This backup holds a file Waymark doesn't make: {n[:80]}")
            plan.append((i, stage / folder / f))
        for i, dest in plan:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as r, open(dest, "wb") as w:
                shutil.copyfileobj(r, w, 1024 * 1024)
    return manifest


def restore(src: Path) -> dict:
    """Replaces this install's data with the backup's. What was here first is kept in backups/ (the database as
    ctu-before-restore-….db, the pictures as files-before-restore-…/)."""
    _check_idle()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=DATA_DIR))   # same disk, so the swap is a rename
    try:
        manifest = _unpack(src, stage)
        _read_db(stage / "ctu.db")
        stamp = now().strftime("%Y-%m-%dT%H%M%S")
        state.pause_all("restore")   # the copy kept below then has the running task's time in it
        kept_db = db.backup(f"before-restore-{stamp}")
        kept_files = db.backup_dir() / f"files-before-restore-{stamp}"
        with db._lock:
            if db._tx_depth:
                raise RuntimeError("restore inside a transaction")
            _check_idle()
            for name, (folder, _) in _folders().items():
                if folder.exists():
                    kept_files.mkdir(parents=True, exist_ok=True)
                    os.replace(folder, kept_files / name)
                if (stage / name).exists():
                    os.replace(stage / name, folder)
            if db._conn is not None:
                db._conn.close()   # folds the WAL into the old file, which is replaced next
                db._conn = None
            os.replace(stage / "ctu.db", DB_PATH)
            for suffix in ("-wal", "-shm"):
                Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
            db.conn()   # opens the restored database and upgrades it if it is from an older version
            profile.reload()   # the restored database may run another plan
        olds = sorted(db.backup_dir().glob("files-before-restore-*"))
        for old in olds[:-KEEP_FILE_COPIES]:
            shutil.rmtree(old, ignore_errors=True)
        return {"created": manifest.get("created"), "kept": str(kept_db)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)
