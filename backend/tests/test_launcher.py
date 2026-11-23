"""The packaged program's start (app/launcher.py) and where it keeps .env (app/paths.py)."""
import socket
from pathlib import Path

from app import launcher, paths


def test_env_file_next_to_app_from_source(monkeypatch):
    monkeypatch.delenv("CTU_ENV_FILE", raising=False)
    monkeypatch.setattr(paths, "FROZEN", False)
    assert paths.env_file() == paths.APP_ROOT / ".env"


def test_env_file_in_data_folder_when_packaged(monkeypatch, tmp_path):
    # the program's own files may be read-only (inside Waymark.app, a temp unpack); the keys go with the data
    monkeypatch.delenv("CTU_ENV_FILE", raising=False)
    monkeypatch.setattr(paths, "FROZEN", True)
    monkeypatch.setenv("CTU_DATA_DIR", str(tmp_path / "data"))
    assert paths.env_file() == tmp_path / "data" / ".env"
    monkeypatch.setenv("CTU_ENV_FILE", str(tmp_path / "x.env"))
    assert paths.env_file() == tmp_path / "x.env"


def test_idle_check():
    g, q = launcher.FIRST_TAB_GRACE_S, launcher.IDLE_QUIT_S
    assert not launcher.idle_check(1, 10_000, 0, None)            # a tab is open
    assert not launcher.idle_check(0, g - 1, 0, None)             # just started, browser still opening
    assert launcher.idle_check(0, g + 1, 0, None)                 # no tab ever came
    assert not launcher.idle_check(0, 500 + q - 1, 0, 500)        # tab closed a moment ago (or reloading)
    assert launcher.idle_check(0, 500 + q + 1, 0, 500)            # every tab closed long enough


def test_pick_port_skips_a_taken_port(monkeypatch):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        taken = s.getsockname()[1]
        monkeypatch.setattr(launcher, "is_waymark", lambda p: False)
        port, running = launcher.pick_port(taken, tries=5)
        assert port != taken and not running
        monkeypatch.setattr(launcher, "is_waymark", lambda p: p == taken)
        assert launcher.pick_port(taken, tries=5) == (taken, True)


def test_spec_ships_no_data():
    spec = (Path(__file__).resolve().parents[2] / "packaging" / "waymark.spec").read_text()
    datas = next(line for line in spec.splitlines() if line.strip().startswith("datas="))
    assert datas.strip() == 'datas=[(str(DIST_UI), "frontend/dist"), (str(ICON), "."), (VERSION_FILE, ".")],'  # UI, icon, version


def test_port_free_right_after_a_server_stops():
    # the open tab is on this port: an update's new program must get the same one back, TIME_WAIT or not
    import threading
    import urllib.request
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    urllib.request.urlopen(f"http://127.0.0.1:{port}/").read()
    assert not launcher.port_free(port)
    srv.shutdown()
    srv.server_close()
    assert launcher.port_free(port)
