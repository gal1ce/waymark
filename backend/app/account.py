"""The local account: who this install belongs to (name, picture, whether their GitHub profile is shown, which plan they
follow). There is no password: the data never leaves this computer. A picture is copied into the data folder, so
deleting the original file later loses nothing."""
from __future__ import annotations

import getpass
import os
import re
import secrets
from pathlib import Path

from . import db, state
from .config import DATA_DIR

NAME_MAX = 60
PHOTO_MAX = 2 * 1024 * 1024
PHOTO_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
PHOTO_NAME = re.compile(r"photo-[0-9a-f]{16}\.(png|jpg|webp|gif)")
GITHUB = ("on", "off")


def photo_dir() -> Path:
    return DATA_DIR / "me"


def _row() -> dict:
    r = db.q1("SELECT name, photo, preset, github, created_at FROM profile WHERE id=1")
    if r is None:  # the migration makes the row; this only guards a database edited by hand
        t = db.ts()
        db.ex("INSERT OR IGNORE INTO profile (id, created_at, updated_at) VALUES (1, ?, ?)", (t, t))
        r = db.q1("SELECT name, photo, preset, github, created_at FROM profile WHERE id=1")
    return r


def photo() -> str | None:
    """The picture's file name, or None when there is none (or the file went missing)."""
    name = _row()["photo"]
    return name if isinstance(name, str) and PHOTO_NAME.fullmatch(name) and (photo_dir() / name).is_file() else None


def system_name() -> str:
    """The name this computer knows its user by: the account's full name when it has one, else the login name.
    Plan setup offers it when the user leaves their name empty."""
    try:
        if os.name == "nt":
            import ctypes
            size = ctypes.c_ulong(0)
            ctypes.windll.secur32.GetUserNameExW(3, None, ctypes.byref(size))   # 3 = NameDisplay
            buf = ctypes.create_unicode_buffer(size.value)
            if size.value and ctypes.windll.secur32.GetUserNameExW(3, buf, ctypes.byref(size)) and buf.value.strip():
                return buf.value.strip()[:NAME_MAX]
        else:
            import pwd
            full = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
            if full:
                return full[:NAME_MAX]
    except Exception:  # noqa: BLE001 - any failure falls back to the login name
        pass
    try:
        return getpass.getuser()[:NAME_MAX]
    except Exception:  # noqa: BLE001
        return ""


def get() -> dict:
    r = _row()
    name = photo()
    return {"name": r["name"], "photo": f"/api/me/photo/{name}" if name else None, "preset": r["preset"],
            "github": r["github"], "created_at": r["created_at"], "system_name": system_name()}


def save_name(name: str) -> dict:
    name = " ".join((name or "").split())
    if len(name) > NAME_MAX:
        raise state.Refused(f"The name can be at most {NAME_MAX} characters.")
    db.ex("UPDATE profile SET name=?, updated_at=? WHERE id=1", (name, db.ts()))
    return get()


def set_github(choice: str) -> dict:
    """'on' shows the GitHub profile (from the local gh CLI) on the Profile page, 'off' keeps the local one."""
    if choice not in GITHUB:
        raise state.Refused("Choose on or off.")
    _row()
    db.ex("UPDATE profile SET github=?, updated_at=? WHERE id=1", (choice, db.ts()))
    return get()


def save_photo(data: bytes, content_type: str) -> dict:
    ext = PHOTO_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if not ext:
        raise state.Refused("Only PNG, JPEG, WebP and GIF pictures can be used.")
    if not data:
        raise state.Refused("The picture is empty.")
    if len(data) > PHOTO_MAX:
        raise state.Refused("The picture is larger than 2 MB.")
    d = photo_dir()
    d.mkdir(parents=True, exist_ok=True)
    old = photo()
    name = f"photo-{secrets.token_hex(8)}.{ext}"   # a new name each time, so browsers never show a stale one
    (d / name).write_bytes(data)
    db.ex("UPDATE profile SET photo=?, updated_at=? WHERE id=1", (name, db.ts()))
    if old:
        (d / old).unlink(missing_ok=True)
    return get()


def clear_photo() -> dict:
    old = photo()
    db.ex("UPDATE profile SET photo=NULL, updated_at=? WHERE id=1", (db.ts(),))
    if old:
        (photo_dir() / old).unlink(missing_ok=True)
    return get()


def photo_path(name: str) -> Path:
    if not PHOTO_NAME.fullmatch(name) or name != photo():
        raise state.Refused("No such picture.")
    return photo_dir() / name
