"""The packaged program's start (Waymark.exe, Waymark.app, the Linux binary; packaging/ builds them).

A double-click starts the server on this computer and opens it in the default browser. A second double-click while it
runs only opens another tab. There is no window of its own: when no tab has been open for a while, it stops by itself,
so closing the browser is how you close the app. What it says goes to waymark.log in the data folder.

    waymark                 start, open the browser
    waymark --no-browser    start without opening it (prints the address)
    waymark --smoke-test    start on a free port, check that the API and the page answer, stop (the release build)
    waymark --after-update PORT   (started by an update, app/updates.py) wait for the old program to let go of PORT,
                                  then start on it without opening a tab: the open one reloads into the new version

PORT=… picks the first port to try (default 8723); when it is taken by something else the next free one is used."""
from __future__ import annotations

import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from . import paths

DEFAULT_PORT = 8723
FIRST_TAB_GRACE_S = 5 * 60   # started, but no tab ever connected: give up after this
IDLE_QUIT_S = 15 * 60        # every tab closed this long ago: stop
CHECK_EVERY_S = 15

log = logging.getLogger("waymark.launcher")


def _fix_child_env() -> None:
    """The Linux bootloader points LD_LIBRARY_PATH at the bundled libraries. This process is already loaded; programs
    it starts (the browser, git, gcc) must get the system's own, or they can crash on a mismatched library."""
    if paths.FROZEN and sys.platform.startswith("linux"):
        orig = os.environ.pop("LD_LIBRARY_PATH_ORIG", None)
        if orig is not None:
            os.environ["LD_LIBRARY_PATH"] = orig
        else:
            os.environ.pop("LD_LIBRARY_PATH", None)


def _no_console_windows() -> None:
    """Windows: the program has no console, so every git or gcc it starts would flash a black window. Programs it
    starts get none, unless the caller asked for something else (an update's restart does)."""
    if not (paths.FROZEN and sys.platform == "win32"):
        return
    import subprocess

    orig = subprocess.Popen.__init__

    def init(self, *a, **k):
        if not k.get("creationflags"):
            k["creationflags"] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
        orig(self, *a, **k)

    subprocess.Popen.__init__ = init  # type: ignore[method-assign]


def _setup_logging(data_dir: Path) -> Path:
    """Everything to waymark.log in the data folder (rotated); also to the console when there is one. A program
    started without a console has no stdout/stderr at all, which some libraries trip over, so those go to the log."""
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "waymark.log"
    handlers: list[logging.Handler] = [
        logging.handlers.RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=2, encoding="utf-8")]
    if sys.stdout is None or sys.stderr is None:
        sink = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 (lives as long as the process)
        sys.stdout = sys.stdout or sink
        sys.stderr = sys.stderr or sink
    else:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        handlers=handlers, force=True)
    return log_path


def is_waymark(port: int) -> bool:
    """Something on this port that answers like Waymark's API (another start of this app, or run.sh)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=3) as r:
            data = json.loads(r.read())
        return isinstance(data, dict) and "plan" in data and "coach_name" in data
    except (OSError, ValueError):
        return False


def port_free(port: int) -> bool:
    """Free as the server would see it: uvicorn binds with SO_REUSEADDR, so a port whose last connections are still in
    TIME_WAIT (a moment after the old program stopped) counts as free. Windows: that option means something else there
    (sharing a port in use), so it isn't set."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(first: int, tries: int = 20) -> tuple[int, bool]:
    """(port, already running): the first free port from `first` on, unless Waymark already answers on one before it."""
    for port in range(first, first + tries):
        if port_free(port):
            return port, False
        if is_waymark(port):
            return port, True
    raise SystemExit(f"waymark: ports {first}-{first + tries - 1} are all taken; start with PORT=… set to another one")


def open_browser(url: str) -> None:
    try:
        if not webbrowser.open(url):
            log.warning("no browser could be opened; open %s yourself", url)
    except Exception:
        log.exception("opening the browser failed; open %s yourself", url)


def idle_check(open_tabs: int, now: float, started: float, last_tab: float | None) -> bool:
    """True when it is time to stop: no tab open, and none for IDLE_QUIT_S (or none ever, FIRST_TAB_GRACE_S)."""
    if open_tabs:
        return False
    if last_tab is None:
        return now - started > FIRST_TAB_GRACE_S
    return now - last_tab > IDLE_QUIT_S


def _watch_idle(server, open_tabs) -> None:
    started, last_tab = time.monotonic(), None
    while not server.should_exit:
        time.sleep(CHECK_EVERY_S)
        now = time.monotonic()
        n = open_tabs()
        if n:
            last_tab = now
        elif idle_check(n, now, started, last_tab):
            log.info("no Waymark tab open for a while: stopping (start it again to come back)")
            server.should_exit = True


def _desktop_entry() -> None:
    """Linux: put the program in the applications menu, pointing at wherever the binary is now (rewritten when moved)."""
    if not (paths.FROZEN and sys.platform.startswith("linux")):
        return
    try:
        share = Path(os.environ.get("XDG_DATA_HOME") or paths.HOME / ".local" / "share")
        icon_src = paths.APP_ROOT / "icon.png"
        icon = share / "icons" / "hicolor" / "512x512" / "apps" / "waymark.png"
        if icon_src.is_file() and (not icon.is_file() or icon.stat().st_size != icon_src.stat().st_size):
            icon.parent.mkdir(parents=True, exist_ok=True)
            icon.write_bytes(icon_src.read_bytes())
        exe = os.environ.get("APPIMAGE") or sys.executable
        body = ("[Desktop Entry]\nType=Application\nName=Waymark\nComment=Your study plan, coach and tests\n"
                f'Exec="{exe}"\nIcon=waymark\nTerminal=false\nCategories=Education;\n')
        f = share / "applications" / "waymark.desktop"
        if not f.is_file() or f.read_text(encoding="utf-8") != body:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(body, encoding="utf-8")
    except OSError:
        log.warning("could not add Waymark to the applications menu", exc_info=True)


def _run_mac(server, url: str, after_stop) -> bool:
    """macOS: a running app is never started twice; a double-click (or a click on the Dock icon) only reopens it. So
    the program keeps an app event loop: reopen opens a browser tab, Quit in the Dock stops the server cleanly. The
    server runs on a thread meanwhile. False when AppKit isn't there (then the caller runs the server plainly)."""
    try:
        from AppKit import NSApplication, NSApplicationActivationPolicyRegular, NSObject
        from PyObjCTools import AppHelper
    except ImportError:
        log.warning("AppKit not found: no Dock integration")
        return False

    NS_TERMINATE_NOW, NS_TERMINATE_LATER = 1, 2
    flags = {"quitting": False}   # Quit chosen in the Dock (vs. a stop on its own)
    worker = threading.Thread(target=server.run, name="server")

    class Delegate(NSObject):
        def applicationShouldHandleReopen_hasVisibleWindows_(self, _app, _flag):
            open_browser(url)
            return False

        def applicationShouldTerminate_(self, _app):
            if not worker.is_alive():
                return NS_TERMINATE_NOW
            flags["quitting"] = True
            server.should_exit = True
            return NS_TERMINATE_LATER

    nsapp = NSApplication.sharedApplication()
    delegate = Delegate.alloc().init()
    nsapp.setDelegate_(delegate)
    nsapp.setActivationPolicy_(NSApplicationActivationPolicyRegular)

    def wait_and_quit() -> None:
        worker.join()
        after_stop()
        # Quit from the Dock waits for this answer; a stop on its own (no tab for a while) quits the app itself
        AppHelper.callAfter(lambda: nsapp.replyToApplicationShouldTerminate_(True) if flags["quitting"]
                            else nsapp.terminate_(None))

    worker.start()
    threading.Thread(target=wait_and_quit, daemon=True).start()
    AppHelper.runEventLoop()
    return True


def _smoke(port: int) -> int:
    """Start, ask the API and the page, stop. Exit code 0 when both answered."""
    import uvicorn

    from .main import app

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None))
    result: dict[str, object] = {}

    def probe() -> None:
        for _ in range(240):
            if server.started:
                break
            time.sleep(0.25)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=10) as r:
                result["meta"] = json.loads(r.read())
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as r:
                result["page"] = r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            result["error"] = repr(e)
        server.should_exit = True

    def verdict() -> int:
        ok = isinstance(result.get("meta"), dict) and "<div id=\"root\"" in str(result.get("page", ""))
        if paths.FROZEN and sys.platform == "darwin":
            try:
                import AppKit  # noqa: F401
                import PyObjCTools.AppHelper  # noqa: F401
            except ImportError as e:
                ok, result["error"] = False, f"no Dock integration in the Mac build: {e!r}"
        print("smoke test:", "ok" if ok else f"FAILED {result.get('error') or result}", flush=True)
        log.info("smoke test: %s", "ok" if ok else f"FAILED {result.get('error') or result}")
        return 0 if ok else 1

    threading.Thread(target=probe, daemon=True).start()
    if paths.FROZEN and sys.platform == "darwin":
        # the Mac program runs its server under the Dock event loop: go through that too, and leave with the verdict
        # (the loop ends the process itself)
        if _run_mac(server, f"http://localhost:{port}", lambda: os._exit(verdict())):
            return 1
    server.run()
    return verdict()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    _fix_child_env()
    _no_console_windows()
    from . import config  # reads .env (from the data folder in the packaged program) and picks the data folder

    log_path = _setup_logging(config.DATA_DIR)
    first = int(os.environ.get("PORT") or DEFAULT_PORT)

    if "--smoke-test" in args:
        port, _ = pick_port(first + 100)
        return _smoke(port)

    if "--after-update" in args:
        # the old program is still shutting down; once its port is free this one takes it
        i = args.index("--after-update")
        if i + 1 < len(args) and args[i + 1].isdigit():
            first = int(args[i + 1])
        for _ in range(120):
            if port_free(first):
                break
            time.sleep(0.5)
        args = [*args, "--no-browser"]

    port, running = pick_port(first)
    url = f"http://localhost:{port}"
    if running:
        log.info("Waymark is already running on %s: opening it", url)
        if "--no-browser" not in args:
            open_browser(url)
        else:
            print(url, flush=True)
        return 0

    log.info("starting Waymark %s on %s (data: %s, log: %s)",
             "(packaged)" if paths.FROZEN else "(source)", url, config.DATA_DIR, log_path)
    _desktop_entry()

    import uvicorn

    from . import bus, state, updates
    from .main import app

    updates.cleanup()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None))
    updates.on_restart = lambda: setattr(server, "should_exit", True)
    updates.port = port

    def when_up() -> None:
        for _ in range(240):
            if server.started or server.should_exit:
                break
            time.sleep(0.25)
        if not server.started:
            return
        if "--no-browser" in args:
            print(f"Waymark: {url}", flush=True)
        else:
            open_browser(url)

    threading.Thread(target=when_up, daemon=True).start()
    threading.Thread(target=_watch_idle, args=(server, lambda: len(bus._subs)), daemon=True).start()

    def after_stop() -> None:
        try:
            state.pause_all("app closed")   # a running timer stops when the app does, not when it next starts
        except Exception:
            log.exception("pausing timers on exit failed")
        log.info("Waymark stopped")

    if paths.FROZEN and sys.platform == "darwin" and _run_mac(server, url, after_stop):
        return 0
    try:
        server.run()
    finally:
        after_stop()
    return 0
