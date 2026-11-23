"""Asking the coach during a graded test: closed book, not off. A rule or formula can be looked up; the turn runs
without tools, without the [TODAY] block (it holds past tests' right answers) and in a conversation of its own.
Nothing here goes to the network."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from app import agent, coach, db, llm, prompts
from conftest import set_now


def _block(text):
    return SimpleNamespace(type="text", text=text, to_dict=lambda: {"type": "text", "text": text})


def _fake_stream(seen):
    async def stream(*, system, messages, tools=None, **kw):
        seen.append({"tools": tools, "messages": list(messages)})  # the turn appends to it afterwards
        yield "text", "For ax + b = cx + d: exactly one solution when a ≠ c."
        yield "final", SimpleNamespace(content=[_block("For ax + b = cx + d: exactly one solution when a ≠ c.")],
                                       stop_reason="end_turn")
    return stream


def _sent(call) -> str:
    """Everything the model got in the last message: the turn folds the system blocks into the user's message."""
    c = call["messages"][-1]["content"]
    return c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c)


def _run(text, cid, closed):
    async def go():
        return [ev async for ev in agent.chat_events(text, cid, closed)]
    return asyncio.run(go())


def test_closed_book_questions_get_their_own_conversation(seeded):
    set_now("2026-11-23T14:00")
    day = coach.create_convo()
    cid = agent.prepare(day, False, closed=True)
    assert cid != day and coach.convo(cid)["title"] == coach.CLOSED_BOOK_TITLE
    # a follow-up stays in it; the day's conversation can't be used closed book
    assert agent.prepare(cid, False, closed=True) == cid
    assert agent.prepare(day, False, closed=True) not in (day, cid)
    # and after the test, the panel opens the day's conversation, not the test's
    coach.touch(cid)
    assert coach.default_convo() == day


def test_a_running_end_of_day_test_makes_chat_closed_book_instead_of_refusing(seeded):
    set_now("2026-11-23T21:30")
    db.ex("INSERT INTO tests(date,kind,status,created_at,questions,answers,time_limit_min,started_at) "
          "VALUES('2026-11-23','eod','in_progress','x',?,'{}',30,?)",
          (json.dumps([{"id": "q1", "type": "short", "prompt": "1+1?", "answer": "2", "topic": "Math"}]), "2026-11-23T21:30:00"))
    assert agent.closed_book(False)
    cid = agent.prepare(None, False, closed=agent.closed_book(False))
    assert coach.convo(cid)["title"] == coach.CLOSED_BOOK_TITLE


def test_closed_book_turn_has_no_tools_no_today_block_and_the_rules(seeded, monkeypatch):
    set_now("2026-11-23T14:00")
    seen = []
    monkeypatch.setattr(llm, "stream", _fake_stream(seen))
    cid = agent.prepare(None, False, closed=True)
    evs = _run("What was the rule for how many solutions ax + b = cx + d has?", cid, True)
    assert evs[-1]["type"] == "done"
    sys = _sent(seen[0])
    assert seen[0]["tools"] is None
    assert prompts.CLOSED_BOOK in sys and "[TODAY]" not in sys and "[KHAN UNIT TESTS]" not in sys

    # an ordinary turn still has its tools and the day
    seen.clear()
    day = agent.prepare(None, False)
    _run("hi", day, False)
    assert seen[0]["tools"] and "[TODAY]" in _sent(seen[0])
