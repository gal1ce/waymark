"""Updates for the packaged program (Waymark.exe, Waymark.app, the Linux binary).

When the app is opened, the page asks here whether GitHub has a newer release (once every few hours at most; only a
plain request for the latest release goes out, nothing about the user). It reads latest.json, a file the release
workflow puts on every release, from github.com: GitHub's API allows only 60 requests an hour per network without an
account, shared with everything else on that network, so the API is asked only for a release without that file. A
failed check is remembered, so opening pages doesn't ask again and again: a rate limit until GitHub says it ends,
anything else for RETRY_AFTER_FAIL (unless the user presses Check for updates). If there is one, the page shows the update
screen: update now, download it yourself, or not now. "Update now" downloads the file for this system, checks its
size and SHA-256 against what GitHub lists, swaps it in for the running program and starts the new one, which waits
for this one to stop and takes over the same port; the open tab reloads into it. The data folder is never touched.

The swap, per system (the old copy is removed on the next start, see cleanup()):
  Linux    the binary is replaced in place (a running file can be replaced there)
  Windows  Waymark.exe is renamed to Waymark.exe.old (a running .exe can be renamed, not overwritten), the new one
           takes its name
  macOS    the .dmg is mounted, Waymark.app copied next to the installed one, the two swapped by renaming

A source checkout (run.sh) has no version and is never updated here; CTU_UPDATE_CURRENT=<version> pretends to be that
version, to try the screen (it can then download nothing, only point at the release page). CTU_UPDATE_FEED=<url> asks
another address than GitHub's (a local file server with a release JSON, to try a whole update end to end).

Release notes: what comes before an `<!-- install -->` line is shown on the screen (the release workflow puts the
tag's message there and the download instructions after it)."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import db, paths

REPO = "gal1ce/waymark"
FEED_URL = f"https://github.com/{REPO}/releases/latest/download/latest.json"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
PAGE_URL = f"https://github.com/{REPO}/releases/latest"
CHECK_EVERY = timedelta(hours=6)
RETRY_AFTER_FAIL = timedelta(minutes=30)
USER_AGENT = "Waymark-update-check"

log = logging.getLogger("ctu.updates")
_lock = threading.Lock()
_later: set[str] = set()          # "Not now" for these versions, until the app is started again
_job: dict[str, Any] = {"phase": "idle"}
# set by the launcher: stops this server so the new program can take its port (the open tab stays on that port)
on_restart: Callable[[], None] | None = None
port: int | None = None


# ------------------------------------------------------------------ versions
def current() -> str:
    """This program's version (written into it by packaging/build.sh), "" for a source checkout."""
    if os.environ.get("CTU_UPDATE_CURRENT"):
        return os.environ["CTU_UPDATE_CURRENT"].strip().lstrip("v")
    try:
        return (paths.APP_ROOT / "version.txt").read_text(encoding="utf-8").strip().lstrip("v")
    except OSError:
        return ""


def parse(v: str) -> tuple[int, ...] | None:
    """'v2026.11.23' or '2026.11.23.2' → (2026, 11, 23, 2); None for anything else."""
    parts = (v or "").strip().lstrip("v").split(".")
    if not parts or not all(p.isdigit() for p in parts):
        return None
    return tuple(int(p) for p in parts)


def newer(latest: str, have: str) -> bool:
    a, b = parse(latest), parse(have)
    return bool(a and b and a > b)


def asset_for(assets: list[dict], system: str | None = None, machine: str | None = None) -> dict | None:
    """The release file for this system (names as packaging/build.sh makes them)."""
    system = system or sys.platform
    machine = (machine or platform.machine()).lower()
    machine = {"amd64": "x86_64", "x64": "x86_64"}.get(machine, machine)
    if system == "win32":
        suffix = "-windows.exe"
    elif system == "darwin":
        suffix = f"-macos-{'arm64' if machine in ('arm64', 'aarch64') else 'x86_64'}.dmg"
    elif system.startswith("linux"):
        suffix = f"-linux-{'aarch64' if machine == 'arm64' else machine}"
    else:
        return None
    for a in assets:
        if str(a.get("name", "")).endswith(suffix):
            return a
    return None


# ------------------------------------------------------------------ where the program is
def target() -> Path | None:
    """What an update replaces: the binary (Linux, Windows) or the .app bundle (macOS). None from source."""
    if not paths.FROZEN:
        return None
    exe = Path(os.environ.get("APPIMAGE") or sys.executable).resolve()
    if sys.platform == "darwin":
        for p in exe.parents:
            if p.suffix == ".app":
                return p
        return None
    return exe


def self_update_block() -> str:
    """Why this copy can't replace itself ("" when it can); the screen then offers the download page only."""
    t = target()
    if t is None:
        return "This copy runs from source; update it with git or a new package."
    if sys.platform == "darwin" and str(t).startswith("/Volumes/"):
        return "Waymark is running from the disk image. Drag it to Applications first, then start it from there."
    if sys.platform == "darwin" and not shutil.which("hdiutil"):
        return "hdiutil is missing on this Mac."
    if not os.access(t.parent, os.W_OK):
        return f"The folder Waymark is in ({t.parent}) can't be written to."
    return ""


# ------------------------------------------------------------------ settings
def enabled() -> bool:
    return bool(db.kv_get("update_check_on", True))


def set_enabled(on: bool) -> None:
    db.kv_set("update_check_on", bool(on))


def skip(version: str) -> None:
    db.kv_set("update_skipped", version)


def later(version: str) -> None:
    _later.add(version)


# ------------------------------------------------------------------ checking
def _failed(out: dict, limited_until: datetime | None) -> None:
    if limited_until:
        out["error"] = "GitHub is limiting requests from this network right now."
        out["retry_at"] = limited_until.strftime("%H:%M")
    else:
        out["error"] = "Couldn't reach GitHub to check for updates."
class Limited(RuntimeError):
    """GitHub's API turned the request away for this network's hourly limit; `until` is when it lifts."""

    def __init__(self, until: datetime):
        self.until = until
        super().__init__(f"rate limited until {until:%H:%M}")


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read())


def _fetch_latest() -> dict:
    """The latest release in the API's shape: latest.json from github.com, else (a release without it) the API."""
    if os.environ.get("CTU_UPDATE_FEED"):
        return _get(os.environ["CTU_UPDATE_FEED"])
    try:
        return _get(FEED_URL)
    except urllib.error.HTTPError as e:   # 404: the latest release has no latest.json; the API knows it anyway
        log.info("latest.json unavailable (%s); asking the API", e.code)
    try:
        return _get(LATEST_URL)
    except urllib.error.HTTPError as e:
        if e.code == 429 or e.code == 403 and (e.headers.get("x-ratelimit-remaining") == "0"
                                               or "rate limit" in str(e.reason).lower()):
            reset = e.headers.get("x-ratelimit-reset")
            raise Limited(datetime.fromtimestamp(int(reset)) if reset and reset.isdigit()
                          else datetime.now() + timedelta(hours=1)) from None
        raise


def _release(raw: dict) -> dict:
    return {
        "version": str(raw.get("tag_name") or "").lstrip("v"),
        "notes": str(raw.get("body") or "").split("<!-- install -->")[0].strip()[:6000],
        "page": raw.get("html_url") or PAGE_URL,
        "published": raw.get("published_at") or "",
        "assets": [{"name": a.get("name", ""), "size": a.get("size", 0), "url": a.get("browser_download_url", ""),
                    "digest": a.get("digest") or ""} for a in raw.get("assets") or []],
    }


def check(force: bool = False, fetch: Callable[[], dict] = _fetch_latest) -> dict:
    """What the update screen needs. Asks GitHub at most every CHECK_EVERY (force: now); quiet when offline."""
    have = current()
    out: dict[str, Any] = {"current": have, "packaged": paths.FROZEN, "enabled": enabled(), "available": False,
                           "show": False, "latest": None, "job": dict(_job)}
    if not have or not (force or out["enabled"]):
        return out
    cached = db.kv_get("update_last_check") or {}
    rel = cached.get("release")
    fresh = cached.get("ts") and datetime.fromisoformat(cached["ts"]) > datetime.now() - CHECK_EVERY
    if force or not fresh or not rel:
        failed = db.kv_get("update_last_fail") or {}
        until = datetime.fromisoformat(failed["until"]) if failed.get("until") else None
        # a rate limit holds even for the button (asking again only uses up the next hour); anything else, not
        if until and until > datetime.now() and (failed.get("limited") or not force):
            _failed(out, until if failed.get("limited") else None)
            if not rel:
                return out
        else:
            try:
                rel = _release(fetch())
                db.kv_set("update_last_check", {"ts": datetime.now().isoformat(timespec="seconds"), "release": rel})
                db.kv_set("update_last_fail", {})
            except Exception as e:  # noqa: BLE001 (offline, GitHub down, no release yet: the app goes on)
                log.info("update check failed: %r", e)
                limited = isinstance(e, Limited)
                until = e.until if limited else datetime.now() + RETRY_AFTER_FAIL
                db.kv_set("update_last_fail", {"until": until.isoformat(timespec="seconds"), "limited": limited})
                _failed(out, until if limited else None)
                if not rel:
                    return out
    out["checked"] = (db.kv_get("update_last_check") or {}).get("ts")
    if not newer(rel["version"], have):
        return out
    asset = asset_for(rel["assets"])
    block = self_update_block() if asset else "There is no file for this system in that release."
    out.update(available=True, latest={k: rel[k] for k in ("version", "notes", "page", "published")},
               asset=asset, self_update=not block, reason=block or None)
    out["show"] = rel["version"] != db.kv_get("update_skipped") and rel["version"] not in _later
    return out


# ------------------------------------------------------------------ updating
def _set(**kw: Any) -> None:
    _job.update(kw)


def _download(asset: dict, dest: Path) -> None:
    total = int(asset.get("size") or 0)
    _set(phase="downloading", done=0, total=total)
    h = hashlib.sha256()
    req = urllib.request.Request(asset["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
            h.update(chunk)
            _job["done"] = _job.get("done", 0) + len(chunk)
    size = dest.stat().st_size
    if total and size != total:
        raise RuntimeError(f"The download is incomplete ({size} of {total} bytes).")
    want = str(asset.get("digest") or "")
    if want.startswith("sha256:") and want[7:].lower() != h.hexdigest():
        raise RuntimeError("The downloaded file doesn't match the release's checksum.")


def _swap_file(new: Path, t: Path) -> None:
    """Linux and Windows: put `new` where the running binary `t` is."""
    if sys.platform == "win32":
        old = t.with_name(t.name + ".old")
        try:
            old.unlink(missing_ok=True)
        except OSError:
            old = t.with_name(f"{t.name}.{int(time.time())}.old")
        os.replace(t, old)
        try:
            os.replace(new, t)
        except OSError:
            os.replace(old, t)   # put the running one back so the app still starts
            raise
    else:
        os.chmod(new, 0o755)
        os.replace(new, t)


def _swap_app(dmg: Path, t: Path) -> None:
    """macOS: mount the .dmg, copy its Waymark.app next to the installed one, swap the two."""
    mnt = Path(tempfile.mkdtemp(prefix="waymark-mnt-"))
    subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mnt), str(dmg)],
                   check=True, capture_output=True, timeout=120)
    staged = t.with_name(".Waymark.app.new")
    try:
        src = next(mnt.glob("*.app"))
        shutil.rmtree(staged, ignore_errors=True)
        subprocess.run(["ditto", str(src), str(staged)], check=True, capture_output=True, timeout=300)
    finally:
        subprocess.run(["hdiutil", "detach", str(mnt), "-force"], capture_output=True, timeout=60, check=False)
        shutil.rmtree(mnt, ignore_errors=True)
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(staged)], capture_output=True, timeout=60, check=False)
    old = t.with_name(".Waymark.app.old")
    shutil.rmtree(old, ignore_errors=True)
    os.rename(t, old)
    try:
        os.rename(staged, t)
    except OSError:
        os.rename(old, t)
        raise


def _start_new(t: Path) -> None:
    """Start the new program; it waits until this one has let go of the port (launcher: --after-update)."""
    args = ["--after-update", str(port or 8723)]
    env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT="1")   # a fresh program, not a child of this one's unpack
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-n", str(t), "--args", *args], env=env, close_fds=True)
    elif sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        subprocess.Popen([str(t), *args], env=env, close_fds=True, creationflags=flags)
    else:
        subprocess.Popen([str(t), *args], env=env, close_fds=True, start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _run(asset: dict, version: str) -> None:
    t = target()
    assert t is not None
    work = Path(tempfile.mkdtemp(prefix="waymark-update-"))
    try:
        # Linux/Windows: download next to the program, so the final rename stays on one disk
        dest = (t.with_name(f".{t.name}.download") if sys.platform != "darwin" else work / asset["name"])
        _download(asset, dest)
        _set(phase="installing")
        if sys.platform == "darwin":
            _swap_app(dest, t)
        else:
            _swap_file(dest, t)
        log.info("updated to %s; restarting", version)
        _set(phase="restarting")
        _start_new(t)
        time.sleep(0.5)
        if on_restart:
            on_restart()
    except Exception as e:
        log.exception("update failed")
        _set(phase="failed", error=str(e) or repr(e))
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if sys.platform != "darwin" and t is not None:
            t.with_name(f".{t.name}.download").unlink(missing_ok=True)


def apply() -> dict:
    """Start updating to the latest release, in the background; the page follows _job through check()."""
    with _lock:
        if _job.get("phase") in ("downloading", "installing", "restarting"):
            return dict(_job)
        info = check()
        if not info.get("available"):
            raise ValueError("There is no newer version.")
        if not info.get("self_update"):
            raise ValueError(info.get("reason") or "This copy can't update itself; download the new version.")
        _set(phase="downloading", done=0, total=info["asset"].get("size", 0), error=None, version=info["latest"]["version"])
        threading.Thread(target=_run, args=(info["asset"], info["latest"]["version"]), name="update", daemon=True).start()
        return dict(_job)


def cleanup() -> None:
    """On start: what an earlier update left (the old program, a half download)."""
    t = target()
    if t is None:
        return
    for p in t.parent.glob(f"{t.name}*.old") if sys.platform == "win32" else []:
        try:
            p.unlink()
        except OSError:
            pass
    leftovers = [t.with_name(".Waymark.app.old"), t.with_name(".Waymark.app.new")] if sys.platform == "darwin" else \
        [t.with_name(f".{t.name}.download")]
    for p in leftovers:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
