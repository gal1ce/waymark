"""The update check and the file swap (app/updates.py)."""
import hashlib
import sys

import pytest

from app import paths, updates

LINUX = [{"name": "waymark-2026.12.1-linux-x86_64"}, {"name": "Waymark-2026.12.1-windows.exe"},
         {"name": "Waymark-2026.12.1-macos-arm64.dmg"}, {"name": "Waymark-2026.12.1-macos-x86_64.dmg"}]


def test_versions():
    assert updates.parse("v2026.11.23") == (2026, 11, 23)
    assert updates.parse("2026.11.23.2") == (2026, 11, 23, 2)
    assert updates.parse("dev") is None and updates.parse("") is None
    assert updates.newer("v2026.12.1", "2026.11.23")
    assert updates.newer("2026.11.23.2", "2026.11.23")
    assert not updates.newer("2026.11.23", "2026.11.23")
    assert not updates.newer("2026.11.1", "2026.11.23")
    assert not updates.newer("nightly", "2026.11.23")


def test_asset_for_each_system():
    pick = lambda s, m: (updates.asset_for(LINUX, s, m) or {}).get("name")
    assert pick("linux", "x86_64") == "waymark-2026.12.1-linux-x86_64"
    assert pick("win32", "AMD64") == "Waymark-2026.12.1-windows.exe"
    assert pick("darwin", "arm64") == "Waymark-2026.12.1-macos-arm64.dmg"
    assert pick("darwin", "x86_64") == "Waymark-2026.12.1-macos-x86_64.dmg"
    assert pick("linux", "aarch64") is None     # no build for it: the screen offers the release page
    assert pick("freebsd14", "amd64") is None


@pytest.fixture
def packaged(monkeypatch, tmp_path):
    """A packaged program at tmp_path/bin/waymark, version 2026.11.23."""
    exe = tmp_path / "bin" / "waymark"
    exe.parent.mkdir()
    exe.write_bytes(b"old program")
    monkeypatch.setattr(paths, "FROZEN", True)
    monkeypatch.setattr(sys, "executable", str(exe))
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("CTU_UPDATE_CURRENT", "2026.11.23")
    monkeypatch.delenv("APPIMAGE", raising=False)
    updates._later.clear()
    return exe


def release(version="v2026.12.1", body="## New\n- faster tests\n<!-- install -->\nDownload the file…"):
    return {"tag_name": version, "body": body, "html_url": "https://example.invalid/r",
            "assets": [{"name": f"waymark-{version.lstrip('v')}-linux-x86_64", "size": 11, "browser_download_url": "https://example.invalid/f",
                        "digest": "sha256:" + hashlib.sha256(b"new program").hexdigest()}]}


def test_check_offers_a_newer_release(packaged, monkeypatch):
    monkeypatch.setattr(updates.platform, "machine", lambda: "x86_64")
    u = updates.check(force=True, fetch=release)
    assert u["available"] and u["show"] and u["self_update"]
    assert u["latest"]["version"] == "2026.12.1"
    assert u["latest"]["notes"] == "## New\n- faster tests"          # the download instructions stay off the screen
    # "Not now" until the next start; "Skip" for good; a newer one after a skip shows again
    updates.later("2026.12.1")
    assert not updates.check(fetch=release)["show"]
    updates._later.clear()
    updates.skip("2026.12.1")
    assert not updates.check(fetch=release)["show"]
    assert updates.check(force=True, fetch=lambda: release("v2026.12.2"))["show"]


def test_check_is_quiet(packaged):
    assert not updates.check(force=True, fetch=lambda: release("v2026.11.23"))["available"]   # the same version
    def offline():
        raise OSError("no network")
    u = updates.check(force=True, fetch=offline)
    assert not u["show"] and u.get("error")
    updates.set_enabled(False)
    calls = []
    assert not updates.check(fetch=lambda: calls.append(1) or release())["available"] and not calls   # switched off: no request
    updates.set_enabled(True)


def test_source_checkout_never_checks(monkeypatch):
    monkeypatch.setattr(paths, "FROZEN", False)
    monkeypatch.delenv("CTU_UPDATE_CURRENT", raising=False)
    monkeypatch.setattr(paths, "APP_ROOT", paths.APP_ROOT / "nowhere")
    calls = []
    u = updates.check(force=True, fetch=lambda: calls.append(1) or release())
    assert u["current"] == "" and not u["available"] and not calls


def test_download_checks_size_and_checksum(tmp_path, monkeypatch):
    src = tmp_path / "src"
    src.write_bytes(b"new program")
    good = {"url": src.as_uri(), "size": 11, "digest": "sha256:" + hashlib.sha256(b"new program").hexdigest()}
    updates._download(good, tmp_path / "a")
    assert (tmp_path / "a").read_bytes() == b"new program"
    with pytest.raises(RuntimeError, match="checksum"):
        updates._download({**good, "digest": "sha256:" + "0" * 64}, tmp_path / "b")
    with pytest.raises(RuntimeError, match="incomplete"):
        updates._download({**good, "size": 99}, tmp_path / "c")


def test_swap_replaces_the_program(packaged, tmp_path):
    new = tmp_path / "new"
    new.write_bytes(b"new program")
    updates._swap_file(new, packaged)
    assert packaged.read_bytes() == b"new program" and packaged.stat().st_mode & 0o111
    assert updates.self_update_block() == ""


def test_self_update_refused_where_it_cant_write(packaged):
    packaged.parent.chmod(0o555)
    try:
        assert "can't be written" in updates.self_update_block()
    finally:
        packaged.parent.chmod(0o755)
