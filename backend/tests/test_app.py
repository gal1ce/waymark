"""HTTP guard, static files, timers, tests, clock, database and watcher."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config, db, files, main, monitor, offline, state, tests_eod
from conftest import ROOT, set_now

BACKEND = Path(__file__).resolve().parents[1]
H = {"x-ctu": "1"}


@pytest.fixture
def client(seeded):
    return TestClient(main.app, base_url="http://127.0.0.1:8723")


# ------------------------------------------------------------------ #2
@pytest.mark.skipif(not main.DIST.exists(), reason="frontend not built")
@pytest.mark.parametrize("path", ["/%2e%2e/%2e%2e/README.md", "/..%2f..%2fREADME.md", "//etc/hostname",
                                  "/%2fetc%2fhostname", "/assets/../../README.md"])
def test_spa_serves_nothing_outside_dist(client, path):
    r = client.get(path)
    index = (main.DIST / "index.html").read_text()
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.text == index


# ------------------------------------------------------------------ #3
def test_guard_rejects_cross_site_and_foreign_hosts(client):
    assert client.post("/api/stuck", json={"summary": "x"}).status_code == 403            # no X-CTU
    assert client.post("/api/stuck", json={"summary": "x"}, headers=H | {"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/stuck", json={"summary": "x"}, headers=H | {"origin": "http://127.0.0.1:9999"}).status_code == 403
    assert client.post("/api/stuck", json={"summary": "x"}, headers=H | {"sec-fetch-site": "cross-site"}).status_code == 403
    assert client.get("/api/meta", headers={"host": "evil.example:8723"}).status_code == 421
    ok = client.post("/api/stuck", json={"summary": "x"}, headers=H | {"origin": "http://127.0.0.1:8723",
                                                                       "sec-fetch-site": "same-origin"})
    assert ok.status_code == 200
    assert client.get("/api/meta").status_code == 200


def test_close_needs_confirmation_when_test_missing(client):
    set_now("2026-11-23T21:40")
    r = client.post("/api/day/2026-11-23/close", json={}, headers=H)
    assert r.status_code == 409 and "End-of-day test" in r.json()["error"]
    check = client.get("/api/day/2026-11-23/close").json()["checklist"]
    assert [c["key"] for c in check] == ["test", "timer", "notes"]


def test_health_endpoint(client):
    h = client.get("/api/health").json()
    assert h["paths"]["study repo"]["ok"] and h["schema_version"] == len(db.MIGRATIONS)


# ------------------------------------------------------------------ #6
def test_timer_stops_counting_when_nobody_is_there(seeded):
    set_now("2026-11-23T10:05")
    t = db.q1("SELECT * FROM tasks WHERE date='2026-11-23' ORDER BY id LIMIT 1")
    state.start_task(t["id"])
    set_now("2026-11-24T10:00")       # laptop slept all night
    assert state.minutes_on_task(t["id"]) == state.GRACE_MIN
    state.pause_away()
    row = db.q1("SELECT * FROM tasks WHERE id=?", (t["id"],))
    assert row["status"] == "todo" and row["spent_sec"] == state.GRACE_MIN * 60


def test_timer_keeps_counting_while_the_app_is_open(seeded):
    set_now("2026-11-23T10:05")
    t = db.q1("SELECT * FROM tasks WHERE date='2026-11-23' ORDER BY id LIMIT 1")
    state.start_task(t["id"])
    for m in range(10, 70, 1):
        set_now(f"2026-11-23T{10 + m // 60:02d}:{m % 60:02d}")
        db.kv_set("last_seen", db.ts())
    assert state.minutes_on_task(t["id"]) == 64
    assert not state.pause_away()


# ------------------------------------------------------------------ #7
def test_interrupted_generation_is_failed_and_retryable(client):
    tid = db.ex("INSERT INTO tests(date,kind,status,created_at) VALUES('2026-11-23','eod','generating','x')")
    assert tests_eod.fail_interrupted() == 1
    assert db.q1("SELECT status FROM tests WHERE id=?", (tid,))["status"] == "failed"


def test_overdue_test_is_submitted_and_unlocks_coach(seeded):
    set_now("2026-11-23T21:30")
    tid = db.ex("INSERT INTO tests(date,kind,status,created_at,questions,answers,time_limit_min,started_at) "
                "VALUES('2026-11-23','eod','in_progress','x',?,?,30,?)",
                (json.dumps([{"id": "q1", "type": "short", "prompt": "1+1?", "answer": "2", "topic": "Math"}]),
                 json.dumps({"q1": "2"}), "2026-11-23T21:30:00"))
    assert tests_eod.active_exam()["id"] == tid
    set_now("2026-11-23T22:05")
    assert tests_eod.active_exam() is None
    assert asyncio.run(tests_eod.expire_overdue()) == [tid]
    t = db.q1("SELECT status, score FROM tests WHERE id=?", (tid,))
    assert t["status"] == "submitted" and t["score"] == 1
    assert db.q1("SELECT note FROM scores WHERE kind='eod_test'")["note"].startswith("auto-submitted")


def test_offline_bank_builds_tests_for_any_day(seeded):
    set_now("2026-11-25T21:00")
    db.ex("UPDATE tasks SET status='done' WHERE date='2026-11-25'")
    qs = offline.build("2026-11-25", "eod")
    assert len(qs) >= 4 and {q["id"] for q in qs} == {f"q{i}" for i in range(1, len(qs) + 1)}
    quiz = offline.build("2026-11-29", "c_quiz", "2-5")
    assert len(quiz) == 5 and all(q["topic"].startswith("C · Beej") for q in quiz)
    assert all(tests_eod._valid(q) for q in qs + quiz)


# ------------------------------------------------------------------ #8
def test_fake_clock_with_offset_is_local_naive():
    dt = config._parse_fake("2026-11-23T10:00+00:00")
    assert dt.tzinfo is None


def _run(code: str, **env) -> subprocess.CompletedProcess:
    e = {k: v for k, v in os.environ.items() if not k.startswith("CTU_")} | env
    return subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env=e, capture_output=True, text=True, timeout=60)


def test_fake_clock_refuses_real_data():
    r = _run("import app.config", CTU_NOW="2026-11-23T10:00")
    assert r.returncode != 0 and "CTU_NOW is set but" in r.stderr


def test_fake_clock_continues_across_restarts(tmp_path):
    env = {"CTU_NOW": "2026-11-23T10:00", "CTU_DB": str(tmp_path / "c.db"), "CTU_STUDY_REPO": str(tmp_path),
           "CTU_COACH_MD": str(tmp_path / "C.md")}
    code = "import time; from app import config; print(config._CLOCK[1].isoformat())"
    a, b = _run(code, **env), _run(code, **env)
    assert a.returncode == 0 and a.stdout == b.stdout


def test_db_refuses_real_database_outside_server():
    r = _run("from app import db; db.q('SELECT 1')")
    assert r.returncode != 0 and "Refusing to open the real database" in r.stderr


# ------------------------------------------------------------------ #9 / #13
def test_backup_is_complete(seeded):
    out = db.backup("test")
    import sqlite3
    c = sqlite3.connect(out)
    assert c.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] > 0
    c.close()


def test_migrations_bring_old_databases_up_to_date(fresh):
    import sqlite3
    path = Path(os.environ["CTU_DB"])
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript(db.SCHEMA)
    c.execute("INSERT INTO kv(key,value) VALUES('fallback_tests', ?)", (json.dumps({"2026-11-23": [{"prompt": "Ne yazdırır?"}]}),))
    c.commit()
    c.close()
    assert db.schema_version() == len(db.MIGRATIONS)
    assert "Ne yazdırır" not in json.dumps(db.kv_get("fallback_tests"))
    cols = {r["name"] for r in db.q("PRAGMA table_info(tests)")}
    assert {"cancelled", "used_sec"} <= cols


# ------------------------------------------------------------------ #11 / #15
def test_watcher_survives_repo_replaced(seeded, monkeypatch):
    monkeypatch.setattr(monitor, "CHECK_EVERY_SEC", 0.3)
    repo = ROOT / "repo"
    seen: list[str] = []

    async def fake_compile(rel, task_id):
        seen.append(rel)
        return {"ok": True, "stderr": ""}

    monkeypatch.setattr(monitor, "compile_c", fake_compile)

    async def scenario():
        w = asyncio.create_task(monitor.watch_repo())
        await asyncio.sleep(1)
        (repo / "a.c").write_text("int main(void){return 0;}\n")
        await _until(lambda: "a.c" in seen)
        import shutil
        shutil.rmtree(repo)
        await _until(lambda: monitor.WATCH["state"] in ("waiting", "restarting"))
        repo.mkdir()
        await _until(lambda: monitor.WATCH["state"] == "watching")
        await asyncio.sleep(0.5)
        (repo / "b.c").write_text("int main(void){return 0;}\n")
        await _until(lambda: "b.c" in seen)
        w.cancel()

    asyncio.run(scenario())
    assert seen[:1] == ["a.c"] and "b.c" in seen


def test_watcher_ignores_the_apps_own_writes(seeded, monkeypatch):
    p = ROOT / "repo" / "PROGRESS.md"
    files.rewrite(p, lambda old: "## PROGRESS\n")

    from watchfiles import Change
    asyncio.run(monitor._handle([(Change.modified, str(p))]))
    assert not db.q1("SELECT 1 FROM events WHERE type='file_change'")


async def _until(cond, timeout=10.0):
    t0 = asyncio.get_running_loop().time()
    while not cond():
        if asyncio.get_running_loop().time() - t0 > timeout:
            raise AssertionError("timed out")
        await asyncio.sleep(0.1)


def test_phase_endpoints(client):
    r = client.post("/api/phases/khan_geometry/approve", headers=H).json()
    assert next(p for p in r["phases"] if p["key"] == "khan_geometry")["approved"]
    assert client.post("/api/phases/nope/approve", headers=H).status_code == 409
    assert client.post("/api/phases/khan_geometry/approve").status_code == 403      # guard applies
    r = client.delete("/api/phases/khan_geometry/approve", headers=H).json()
    assert not next(p for p in r["phases"] if p["key"] == "khan_geometry")["approved"]


def test_rewrite_task_needs_its_file(seeded):
    set_now("2026-11-23T18:00")
    tid = db.ex("INSERT INTO tasks(date,block_id,ord,title,kind,files,est_min) VALUES('2026-11-23',1,99,'rw','rewrite',?,60)",
                (json.dumps(["cpp/kintsugi/rewrite/include/x.h"]),))
    with pytest.raises(state.Refused):
        state.complete_task(tid)
    f = ROOT / "repo" / "cpp/kintsugi/rewrite/include/x.h"
    f.parent.mkdir(parents=True)
    f.write_text("#pragma once\nclass DiskManager { public: void read_page(int id); };\n")
    state.complete_task(tid)
