"""A plan of the user's own: onboarding answers → the model's draft → the app's checks → the user's approval → days
planned from the plan's tracks, unit checks that hold a unit back until it is passed, PLAN.md, and the API key the
user brings. The model is replaced by fixed replies; nothing here goes to the network."""
from __future__ import annotations

import asyncio
import io
import json
import os
import stat
import zipfile
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import (agent, db, keys, llm, main, onboarding, planlog, planner, profile, prompts, state, tests_eod, tracks)
from conftest import new_install, set_now

H = {"x-ctu": "1"}
KEY = "sk-ant-api03-" + "x" * 40

ANSWERS = {
    "field": "Mathematics + computer science", "level": "Master's student", "goal": "Pass the analysis qualifying exam",
    "deadline": "2027-09", "background": "Calculus, linear algebra", "focus": "real analysis, algorithms",
    "sources": "Abbott, CLRS", "weekdays": [0, 2, 4], "day_start": "09:00", "day_end": "18:00", "hours": 6,
    "start_date": "2026-11-24", "language": "tr", "code": False,
}


def _unit(title, sessions=1, href=""):
    return {"title": title, "objective": f"Prove the main results of {title}.", "practice": "Odd exercises.",
            "sessions": sessions, "resources": [{"label": f"Abbott · {title}", "href": href}]}


def model_draft(**over) -> dict:
    d = {
        "label": "Analysis + algorithms", "summary": "Two tracks towards the qualifying exam.",
        "week": [
            {"weekday": 0, "blocks": [
                {"start": "09:00", "end": "11:30", "track": "analysis", "title": "Analysis"},
                {"start": "11:30", "end": "12:00", "track": "break", "title": "Break"},
                {"start": "12:00", "end": "14:00", "track": "algo", "title": "Algorithms"},
                {"start": "17:30", "end": "18:00", "track": "test", "title": "End-of-day test"}]},
            # overlapping blocks, an unknown track, no test block: the app repairs it
            {"weekday": 2, "blocks": [
                {"start": "09:00", "end": "12:00", "track": "analysis", "title": "Analysis"},
                {"start": "11:00", "end": "13:00", "track": "algo", "title": "Algorithms"},
                {"start": "14:00", "end": "15:00", "track": "topology", "title": "Topology"}]},
            {"weekday": 4, "blocks": [
                {"start": "09:00", "end": "13:00", "track": "algo", "title": "Algorithms"},
                {"start": "07:00", "end": "08:00", "track": "analysis", "title": "Too early"}]},
            {"weekday": 6, "blocks": [{"start": "09:00", "end": "12:00", "track": "analysis", "title": "Not chosen"}]},
        ],
        "tracks": [
            {"key": "analysis", "label": "Real analysis", "goal": "Abbott ch. 1–5",
             "units": [_unit("The real numbers"), _unit("Sequences", 2), _unit("Series")]},
            {"key": "algo", "label": "Algorithms", "goal": "CLRS parts I–II",
             "units": [_unit("Sorting", href="http://insecure.example/x"), _unit("Graphs")]},
        ],
        "goals": [{"label": "Qualifying exam", "target": "pass", "note": "Sep 2027"}],
        "unit_pass": 4,
        "roadmap": [{"start": "2026-11", "end": "2027-02", "items": ["Abbott 1–5"]},
                    {"start": "bad", "end": "2027-03", "items": ["dropped"]}],
        "coach": {"intro": "You are the user's study coach inside their study app. The user is a master's student.",
                  "context": "Abbott for analysis, CLRS for algorithms.", "learning_work": "proofs, problem sets",
                  "own_work": "their assigned proof", "practice_subjects": "analysis, algorithms",
                  "stuck_examples": '"choosing epsilon"'},
        "planner_rules": "Proofs are written in full.\n- Algorithms: prove correctness before coding.",
        "eod_rules": "- Analysis: one short proof step.", "practice_rules": "- mcq and short only.",
        "notes": ["Check the edition of Abbott."],
    }
    d.update(over)
    return d


@pytest.fixture
def client(fresh, monkeypatch):
    new_install()
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setattr(onboarding, "check_links", lambda plan: [])
    return TestClient(main.app, base_url="http://127.0.0.1:8723")


def _fake_model(monkeypatch, draft: dict | None = None):
    calls = []

    async def structured(system, prompt, schema, effort="medium", max_tokens=16000):
        calls.append((system, prompt))
        if schema is onboarding.DRAFT_SCHEMA:
            return draft or model_draft()
        raise RuntimeError("no model in tests")   # the day planner falls back to its own draft

    async def structured_live(system, prompt, schema, on, effort="medium", max_tokens=16000):
        out = await structured(system, prompt, schema, effort, max_tokens)
        text = json.dumps(out)
        for i in range(0, len(text), 40):       # streamed in pieces, as the model does
            on("text", text[i:i + 40])
        return out
    monkeypatch.setattr(llm, "structured", structured)
    monkeypatch.setattr(llm, "structured_live", structured_live)
    return calls


def _draft_and_approve(client, monkeypatch, draft=None):
    calls = _fake_model(monkeypatch, draft)
    r = client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    assert r.status_code == 200, r.text
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    assert st["status"] == "ready", st
    r = client.post("/api/onboarding/approve", json={"confirm": True}, headers=H)
    assert r.status_code == 200, r.text
    asyncio.run(planner.ensure_horizon())
    return st, calls


# ------------------------------------------------------------------ a new install
def test_a_new_install_plans_nothing_until_it_has_a_plan(client):
    asyncio.run(planner.ensure_horizon())
    assert not db.q1("SELECT 1 FROM days")
    meta = client.get("/api/meta").json()
    assert meta["plan"] == {"key": None, "ready": False, "label": "", "modules": []}
    assert "COACH.md" not in client.get("/api/health").json()["paths"]


def test_drafting_needs_the_users_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    r = client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    assert r.status_code == 409 and "API key" in r.json()["error"]


@pytest.mark.parametrize("bad, msg", [({"weekdays": []}, "study day"), ({"day_start": "9"}, "HH:MM"),
                                      ({"day_end": "09:30"}, "an hour"), ({"field": "", "goal": ""}, "what you study"),
                                      ({"deadline": "soon"}, "a date"),
                                      ({"deadline": "2027-02-30"}, "a date"), ({"deadline": "2026-11-01"}, "after the start")])
def test_the_answers_are_checked(client, bad, msg):
    r = client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, **bad}}, headers=H)
    assert r.status_code == 409 and msg in r.json()["error"]


# ------------------------------------------------------------------ the app checks the model's draft
def test_the_draft_is_repaired_to_the_apps_rules():
    a = onboarding.clean_answers(ANSWERS)
    plan, notes = onboarding.normalize(model_draft(), a)
    assert [t["key"] for t in plan["tracks"]] == ["analysis", "algo"]
    assert plan["study_weekdays"] == [0, 2, 4] and plan["week"][6] == []    # Sunday wasn't chosen
    wed = plan["week"][2]
    assert [(b["start"], b["end"], b["kind"]) for b in wed] == [
        ("09:00", "12:00", "analysis"), ("12:00", "13:00", "algo"), ("14:00", "15:00", "analysis"),
        ("15:00", "15:30", "test")]                                         # overlap cut, unknown track, test added
    fri = plan["week"][4]
    assert fri[0]["start"] == "09:00" and fri[-1]["kind"] == "test" and len(fri) == 2   # 07:00 is before the day
    assert all(b["kind"] == "test" for b in (d[-1] for d in plan["week"] if d))
    assert plan["tracks"][1]["units"][0]["resources"][0]["href"] == ""     # http link dropped, the name kept
    assert any("not an https" in n for n in notes) and any("Topology" in n for n in notes)
    assert "Check the edition of Abbott." in notes
    # the roadmap follows the schedule (units ending each month), then review until the deadline
    assert [r["start"] for r in plan["roadmap"]] == ["2026-11", "2026-12", "2026-12"]
    assert "Real analysis: finish The real numbers" in plan["roadmap"][0]["items"]
    assert plan["roadmap"][-1]["end"] == "2027-09" and "Review" in plan["roadmap"][-1]["items"][0]
    assert plan["thresholds"]["unit_quiz"]["threshold"] == 4
    assert "Monday: 09:00–11:30 Real analysis (150 min), 12:00–14:00 Algorithms (120 min)" in plan["planner"]["frame"]
    assert plan["planner"]["rules"].startswith("- Each unit of a track") and "- Proofs are written in full." in plan["planner"]["rules"]
    assert plan["answers"]["language"] == "tr" and "plan_text" not in plan["answers"]
    json.loads(json.dumps(plan))   # plain data, like the presets


def test_a_draft_with_nothing_usable_is_refused():
    a = onboarding.clean_answers(ANSWERS)
    with pytest.raises(state.Refused):
        onboarding.normalize(model_draft(tracks=[{"key": "x", "label": "", "units": []}]), a)
    with pytest.raises(state.Refused, match="hours a week"):
        many = [{"weekday": d, "blocks": [{"start": f"{h:02d}:00", "end": f"{h + 4:02d}:00", "track": "analysis",
                                            "title": "A"} for h in (0, 4, 8, 12, 16)]} for d in range(7)]
        onboarding.normalize(model_draft(week=many), {**a, "weekdays": list(range(7)), "day_start": "00:00",
                                                     "day_end": "23:59"})


def test_the_model_never_sees_more_than_the_answers(client, monkeypatch):
    calls = _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "plan_text": "# My plan\n- Rudin 1-3",
                                                            "plan_file": "COACH.md"}}, headers=H)
    asyncio.run(onboarding.run())
    system, prompt = calls[0]
    assert system == onboarding.DRAFT_SYSTEM and "<plan_file>\n# My plan\n- Rudin 1-3\n</plan_file>" in prompt
    assert "COACH.md" in prompt
    # the imported file is kept for revisions only, never in the approved plan or the public status
    assert "plan_text" not in client.get("/api/onboarding").json()["answers"]


# ------------------------------------------------------------------ approval and the days it plans
def test_approving_a_draft_runs_it(client, monkeypatch):
    st, _ = _draft_and_approve(client, monkeypatch)
    assert st["draft"]["notes"]
    assert profile.key() == "custom" and profile.engine() == "tracks" and profile.ready()
    days = db.q("SELECT date FROM days ORDER BY date")
    assert [d["date"] for d in days] == ["2026-11-25", "2026-11-27"]     # Wed, Fri: the plan starts on Tuesday
    blocks = db.q("SELECT kind, title FROM blocks WHERE date='2026-11-25' ORDER BY ord")
    assert [b["kind"] for b in blocks] == ["analysis", "algo", "analysis", "test"]
    tasks = db.q("SELECT t.title, t.kind, b.kind AS bk FROM tasks t JOIN blocks b ON b.id=t.block_id "
                 "WHERE t.date='2026-11-25' ORDER BY b.ord, t.ord")
    assert [(t["bk"], t["kind"]) for t in tasks][:3] == [("analysis", "read"), ("analysis", "practice"),
                                                         ("analysis", "unit_quiz")]
    # the second analysis block of the day goes on to the next unit (Sequences, 2 sessions)
    assert ("analysis", "read") in [(t["bk"], t["kind"]) for t in tasks[5:]]
    assert any(t["title"] == "Sequences · study (1/2)" for t in tasks)
    assert db.q1("SELECT 1 FROM tasks WHERE kind='test' AND date='2026-11-25'")
    # the plan, as a file and in the prompts
    text = planlog.path().read_text()
    assert text.startswith("# Analysis + algorithms") and "## Real analysis" in text and "Plan approved" in text
    assert "The user is a master's student." in prompts.coach_system()
    assert "Kintsugi" not in prompts.coach_system() and "Beej" not in prompts.coach_system()
    assert "output (exact output" not in prompts.eod_system()        # no programming in this plan
    assert "Monday: 09:00–11:30" in prompts.planner_system()
    assert [t["name"] for t in agent.tools() if t["name"] == "read_file"] and \
        next(t for t in agent.tools() if t["name"] == "read_file")["input_schema"]["properties"]["scope"]["enum"] == ["repo", "plan"]
    from app import coach
    assert coach.settings()["language"] == "tr"
    plan = client.get("/api/plan").json()
    assert plan["key"] == "custom" and plan["tracks"][0]["label"] == "Real analysis" and plan["progress"]


def test_a_plan_approved_on_a_study_day_starts_that_day(client, monkeypatch):
    _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": {**ANSWERS, "start_date": "2026-11-23"}}, headers=H)
    asyncio.run(onboarding.run())
    client.post("/api/onboarding/approve", json={"confirm": True}, headers=H)
    asyncio.run(planner.ensure_horizon())
    assert [d["date"] for d in db.q("SELECT date FROM days ORDER BY date")] == ["2026-11-23", "2026-11-25", "2026-11-27"]
    assert state.get_day("2026-11-23")["status"] == "active" and state.get_day("2026-11-23")["blocks"]


def test_weeks_run_monday_to_sunday_when_a_plan_starts_midweek(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)                  # starts Tuesday 24 November
    from app import config
    assert config.week_start() == date(2026, 11, 23) and config.week_index(date(2026, 11, 29)) == 0
    assert config.week_index(date(2026, 11, 30)) == 1
    ov = client.get("/api/overview").json()
    assert ov["weeks"][0]["start"] == "2026-11-23"
    days = {d["date"]: d["short"] for d in ov["weeks"][0]["days"]}
    assert days["2026-11-25"] == "Wed" and days["2026-11-24"] == "Tue"   # labels follow the real weekday


def test_a_deadline_can_be_a_day_or_a_month(client):
    for d in ("2027-09", "2027-09-15"):
        assert onboarding.clean_answers({**ANSWERS, "deadline": d})["deadline"] == d


def test_the_draft_reports_its_progress_while_the_model_writes(client, monkeypatch):
    seen = []
    _fake_model(monkeypatch)
    real_scan = onboarding._scan

    def spy(text):
        real_scan(text)
        seen.append(onboarding.status().get("progress"))
    monkeypatch.setattr(onboarding, "_scan", spy)
    client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    asyncio.run(onboarding.run())
    p = [x for x in seen if x][-1]
    assert p["phase"] == "writing" and p["units"] >= 1 and p["tracks"] and p["elapsed"] >= 0
    assert "progress" not in onboarding.status()          # finished: nothing in flight


def test_a_change_request_rewrites_the_draft(client, monkeypatch):
    calls = _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    asyncio.run(onboarding.run())
    _fake_model(monkeypatch, model_draft(label="Changed"))
    r = client.post("/api/onboarding/change", json={"change": "Less algorithms"}, headers=H)
    assert r.status_code == 200
    asyncio.run(onboarding.run())
    st = client.get("/api/onboarding").json()
    assert st["status"] == "ready" and st["draft"]["plan"]["label"] == "Changed"
    assert len(calls) == 1   # the first fake was replaced; the change went to the second


def test_approving_needs_confirmation_and_a_finished_draft(client, monkeypatch):
    assert client.post("/api/onboarding/approve", json={"confirm": True}, headers=H).status_code == 409
    _fake_model(monkeypatch)
    client.post("/api/onboarding/draft", json={"answers": ANSWERS}, headers=H)
    asyncio.run(onboarding.run())
    assert client.post("/api/onboarding/approve", json={"confirm": False}, headers=H).status_code == 409
    assert profile.key() is None


def test_switching_from_the_ctu_plan_keeps_the_work_already_done(seeded, monkeypatch):
    """The CTU user (or anyone) moving to a new plan: started days stay, untouched days ahead are planned again, and a
    copy of the database is kept first."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setattr(onboarding, "check_links", lambda plan: [])
    client = TestClient(main.app, base_url="http://127.0.0.1:8723")
    tid = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' LIMIT 1")["id"]
    state.start_task(tid)
    _draft_and_approve(client, monkeypatch)
    assert db.q1("SELECT 1 FROM tasks WHERE id=?", (tid,))                     # Monday, started: kept
    assert db.q1("SELECT kind FROM blocks WHERE date='2026-11-25' LIMIT 1")["kind"] == "analysis"
    assert not db.q1("SELECT 1 FROM days WHERE date='2026-11-24'")             # a CTU day nobody touched: gone
    assert list(db.backup_dir().glob("ctu-before-plan-*.db"))


# ------------------------------------------------------------------ unit checks
def _questions(n=5):
    return [{"id": f"q{i}", "type": "short", "topic": "Analysis", "prompt": "?", "math": "", "code": "",
             "choices": [], "answer": "1", "accept": [], "answer_format": "", "explanation": ""} for i in range(1, n + 1)]


def test_a_failed_unit_check_is_studied_again_and_retaken(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    set_now("2026-11-25T09:00")
    quiz = db.q1("SELECT * FROM tasks WHERE date='2026-11-25' AND kind='unit_quiz' ORDER BY id LIMIT 1")
    assert json.loads(quiz["meta"])["item"] == "Real analysis · The real numbers"
    assert client.post("/api/tasks/%d/done" % quiz["id"], headers=H).status_code == 409   # take the check first

    async def live(system, prompt, schema, on, effort="medium", max_tokens=16000):
        assert system == prompts.unit_quiz_system() and "Unit: The real numbers" in prompt
        return {"questions": _questions()}
    monkeypatch.setattr(llm, "structured_live", live)
    r = client.post("/api/tests/generate", json={"kind": "unit_quiz", "task_id": quiz["id"]}, headers=H)
    tid = r.json()["id"]
    asyncio.run(tests_eod.fill(tid))
    assert client.post("/api/tests/generate", json={"kind": "unit_quiz", "task_id": quiz["id"]}, headers=H).json()["id"] == tid
    tests_eod.start(tid)
    out = asyncio.run(tests_eod.submit(tid, {"q1": "1", "q2": "1", "q3": "1", "q4": "0", "q5": "0"}))
    assert out["score"] == 3
    s = db.q1("SELECT * FROM scores WHERE kind='unit_quiz'")
    assert s["item"] == "Real analysis · The real numbers" and s["passed"] == 0 and s["threshold"] == 4
    assert tracks.progress()[0]["units"][0]["status"] == "tried"

    asyncio.run(planner.close_day("2026-11-25"))
    # Friday has no analysis block: the retake opens the next one, Monday's
    assert not db.q1("SELECT 1 FROM blocks WHERE date='2026-11-27' AND kind='analysis'")
    mon = db.q("SELECT t.title, t.kind FROM tasks t JOIN blocks b ON b.id=t.block_id WHERE t.date='2026-11-30' "
               "AND b.kind='analysis' ORDER BY b.ord, t.ord")
    assert mon[0]["title"] == "The real numbers · study again" and mon[1]["title"] == "The real numbers · unit check (retake)"
    # one retake only, however often the days ahead are planned
    asyncio.run(planner.ensure_horizon())
    asyncio.run(planner.close_day("2026-11-27"))
    assert db.q1("SELECT COUNT(*) n FROM tasks WHERE kind='unit_quiz' AND title LIKE '%retake%'")["n"] == 1


def test_a_failed_check_moves_into_an_already_planned_block(client, monkeypatch):
    """When the track's next block is already planned, the close puts the retake at its start."""
    _draft_and_approve(client, monkeypatch, model_draft(week=[
        {"weekday": d, "blocks": [{"start": "09:00", "end": "12:00", "track": "analysis", "title": "Analysis"}]}
        for d in (0, 2, 4)]))
    set_now("2026-11-25T09:00")
    quiz = db.q1("SELECT * FROM tasks WHERE date='2026-11-25' AND kind='unit_quiz'")
    db.ex("INSERT INTO scores(ts,date,task_id,kind,item,value,max,threshold,passed) VALUES(?,?,?,?,?,?,?,?,?)",
          (db.ts(), "2026-11-25", quiz["id"], "unit_quiz", json.loads(quiz["meta"])["item"], 2, 5, 4, 0))
    asyncio.run(planner.close_day("2026-11-25"))
    fri = db.q("SELECT t.title, t.est_min FROM tasks t JOIN blocks b ON b.id=t.block_id WHERE t.date='2026-11-27' "
               "AND b.kind='analysis' ORDER BY t.ord")
    assert fri[0]["title"] == "The real numbers · study again" and "retake" in fri[1]["title"]
    assert sum(t["est_min"] for t in fri) <= 180 + 15            # what didn't fit moved on
    assert db.q1("SELECT version FROM days WHERE date='2026-11-27'")["version"] == "adapted"


def test_unknown_test_kinds_are_refused(client):
    assert client.post("/api/tests/generate", json={"kind": "drop table"}, headers=H).status_code == 409


def test_the_cursor_walks_through_units_and_their_sessions():
    a = onboarding.clean_answers(ANSWERS)
    plan, _ = onboarding.normalize(model_draft(), a)
    db.kv_set("plan", plan)
    db.ex("UPDATE profile SET preset='custom' WHERE id=1")
    profile.reload()
    titles = []
    for d in (date(2026, 11, 23), date(2026, 11, 25), date(2026, 11, 27), date(2026, 11, 30)):
        p = tracks.template_day(d)
        tracks.advance(d, p)
        titles += [t["title"] for k, ts in p.items() if k.startswith("analysis") for t in ts if t["kind"] == "read"]
    assert titles[:4] == ["The real numbers · study", "Sequences · study (1/2)", "Sequences · study (2/2)",
                          "Series · study"]
    assert tracks.runway()[0]["left"] == 0
    assert any(t["kind"] == "review" for t in tracks.template_day(date(2026, 12, 2)).get("analysis", []))


# ------------------------------------------------------------------ the user's own key
def test_the_key_is_kept_in_the_data_folder_and_never_in_a_backup(fresh, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(keys, "_from_app", False)

    async def works(k):
        return None if k == KEY else "Anthropic doesn't accept this key."
    monkeypatch.setattr(keys, "_works", works)
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    assert c.get("/api/settings/key").json()["set"] is False
    assert c.put("/api/settings/key", json={"key": "nope"}, headers=H).status_code == 409
    assert c.put("/api/settings/key", json={"key": "sk-ant-api03-" + "y" * 40}, headers=H).status_code == 409
    r = c.put("/api/settings/key", json={"key": KEY}, headers=H)
    assert r.status_code == 200 and r.json() == {"set": True, "source": "app", "hint": "…xxxx", "free_mode": False}
    assert os.environ["ANTHROPIC_API_KEY"] == KEY
    assert stat.S_IMODE(keys.path().stat().st_mode) == 0o600
    z = zipfile.ZipFile(io.BytesIO(c.post("/api/backup/export", headers=H).content))
    assert not any("key" in n for n in z.namelist())
    assert all(KEY.encode() not in z.read(n) for n in z.namelist())
    assert c.delete("/api/settings/key", headers=H).json()["set"] is False
    assert not keys.path().exists() and "ANTHROPIC_API_KEY" not in os.environ


def test_a_key_from_the_environment_is_left_alone(fresh, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setattr(keys, "_from_app", False)
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    assert c.get("/api/settings/key").json()["source"] == "env"
    assert c.delete("/api/settings/key", headers=H).status_code == 409


def test_the_account_offers_the_computers_user_name(client):
    me = client.get("/api/me").json()
    assert isinstance(me["system_name"], str) and me["system_name"]
    r = client.put("/api/me", json={"name": "  Ada   Lovelace "}, headers=H)
    assert r.json()["name"] == "Ada Lovelace"
