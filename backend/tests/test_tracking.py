"""The coach sees the user's work: a test is recorded question by question (answer, time spent, answers changed), every
submission is on the event log, and the coach's snapshot names the wrong questions so it never has to ask which ones."""
from __future__ import annotations

import json

from app import agent, db, tests_eod
from test_custom_plan import H, _draft_and_approve, client  # noqa: F401
from test_review_fixes_2 import _q


def _ready_test(n: int = 3) -> int:
    tid = tests_eod.create_practice({"topics": "Limits", "topic_list": [], "count": n, "level": "easy"})
    qs = [{**_q(i), "prompt": f"What is the limit number {i}?"} for i in range(1, n + 1)]
    db.ex("UPDATE tests SET status='ready', questions=? WHERE id=?", (json.dumps(qs), tid))
    return tid


def test_a_coach_test_is_recorded_question_by_question(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    tid = _ready_test()
    assert client.post(f"/api/tests/{tid}/start", headers=H).status_code == 200
    trace = {"q1": {"sec": 40, "visits": 1, "changes": 0}, "q2": {"sec": 7, "visits": 2, "changes": 2}}
    client.put(f"/api/tests/{tid}/answers", json={"answers": {"q1": "1", "q2": "5"}, "trace": trace}, headers=H)
    assert client.get(f"/api/tests/{tid}").json()["trace"]["q2"]["changes"] == 2   # a resumed page starts from it
    r = client.post(f"/api/tests/{tid}/submit", json={"answers": {"q1": "1", "q2": "5"}, "trace": trace}, headers=H).json()
    res = {x["id"]: x for x in r["results"]}
    assert res["q1"]["correct"] and res["q1"]["sec"] == 40
    assert not res["q2"]["correct"] and res["q2"]["sec"] == 7 and res["q2"]["changes"] == 2

    # made by the coach (no task), and still on the record with what went wrong
    ev = db.q1("SELECT * FROM events WHERE type='practice_submitted' ORDER BY id DESC")
    data = json.loads(ev["data"])
    assert ev["task_id"] is None and data["wrong"] == ["q2 Limits"] and data["empty"] == ["q3 Limits"] and data["sec"] == 47
    assert db.q1("SELECT 1 FROM events WHERE type='test_started'")

    # the coach knows which ones without asking
    snap = agent._recent_tests_block()
    assert f"#{tid} practice test" in snap and "Q2 [Limits] WRONG, 7 s" in snap and "user: 5 | right: 1" in snap
    assert "Q3 [Limits] EMPTY" in snap and "Q1 [Limits] correct, 40 s" in snap
    full = agent.test_detail(tid)
    assert "Q2" in full and "answer changed 2x" in full and "→ WRONG" in full
    assert "practice_submitted" in agent.activity(1)


def test_answers_stay_hidden_while_a_test_runs(client, monkeypatch):
    _draft_and_approve(client, monkeypatch)
    tid = _ready_test()
    client.post(f"/api/tests/{tid}/start", headers=H)
    assert "answers hidden" in agent.test_detail(tid) and "right answer" not in agent.test_detail(tid)
    assert "in progress" in agent._recent_tests_block()


def test_a_review_task_gets_a_practice_set(client, monkeypatch):
    from app import main
    _draft_and_approve(client, monkeypatch)
    monkeypatch.setattr(main, "spawn", lambda coro: coro.close())
    day = db.q1("SELECT date, block_id FROM tasks ORDER BY date LIMIT 1")
    task = db.ex("INSERT INTO tasks(date, block_id, ord, title, detail, kind) VALUES(?,?,?,?,?,?)",
                 (day["date"], day["block_id"], 99, "Redo missed equations", "Linear equations with negative coefficients", "review"))
    from app.config import today
    db.ex("UPDATE tasks SET date=? WHERE id=?", (today().isoformat(), task))
    r = client.post(f"/api/tasks/{task}/practice", headers=H)
    assert r.status_code == 200, r.text
    assert db.q1("SELECT kind, task_id FROM tests WHERE id=?", (r.json()["id"],)) == {"kind": "practice", "task_id": task}
