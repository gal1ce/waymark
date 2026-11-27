"""What the coach did on the way (its tool steps) and the replies it suggests next: both stream to the client and are
kept with the reply, and the <followups> block never shows in the reply itself. Nothing here goes to the network."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app import agent, coach, llm
from conftest import set_now


def _text(t):
    return SimpleNamespace(type="text", text=t, to_dict=lambda: {"type": "text", "text": t})


def _use(name, args):
    d = {"type": "tool_use", "id": "tu1", "name": name, "input": args}
    return SimpleNamespace(type="tool_use", id="tu1", name=name, input=args, to_dict=lambda: d)


def _run(text, cid):
    async def go():
        return [ev async for ev in agent.chat_events(text, cid, False)]
    return asyncio.run(go())


def test_split_followups():
    body, f = agent.split_followups("Here it is.\n\n<followups>\n- Give me an example\n2. Quiz me\n\nQuiz me\n</followups>")
    assert body == "Here it is." and f == ["Give me an example", "Quiz me"]
    assert agent.split_followups("No block.") == ("No block.", [])
    # cut off before the closing tag: still never shown
    assert agent.split_followups("Done.\n<followups>\nOne more")[0] == "Done."
    assert agent._hide_followups("Done.\n\n<follo") == "Done."
    assert agent._hide_followups("x < y") == "x < y"


def test_steps_and_followups_stream_and_are_kept(seeded, monkeypatch):
    set_now("2026-11-23T14:00")
    calls = []

    async def stream(*, system, messages, tools=None, **kw):
        calls.append(1)
        if len(calls) == 1:
            yield "text", "Let me look at the plan."
            yield "tool", "get_day"
            yield "final", SimpleNamespace(content=[_text("Let me look at the plan."), _use("get_day", {"date": ""})],
                                           stop_reason="tool_use")
        else:
            reply = "Start with the warm-up.\n\n<followups>\nWhat is the warm-up?\nMove it to tonight\n</followups>"
            for part in (reply[:30], reply[30:60], reply[60:]):
                yield "text", part
            yield "final", SimpleNamespace(content=[_text(reply)], stop_reason="end_turn")
    monkeypatch.setattr(llm, "stream", stream)
    cid = agent.prepare(None, False)
    evs = _run("Something small to do today?", cid)

    steps = [e for e in evs if e["type"] == "step"]
    assert [s["state"] for s in steps] == ["run", "ok"]
    assert steps[0]["label"] == "Looking at your day" and steps[0]["at"] == len("Let me look at the plan.")
    streamed = ""
    for e in evs:
        if e["type"] == "delta":
            streamed += e["text"]
        elif e["type"] == "replace":
            streamed = e["text"]
    assert "<follo" not in streamed

    done = evs[-1]
    assert done["type"] == "done" and "<followups>" not in done["reply"]
    assert done["followups"] == ["What is the warm-up?", "Move it to tonight"]
    assert done["steps"] == [{"tool": "get_day", "label": "Looking at your day", "at": 24, "state": "ok"}]

    last = coach.messages(cid)[-1]
    assert last["role"] == "assistant" and last["display"] == done["reply"]
    assert last["followups"] == done["followups"] and last["steps"] == done["steps"]
    assert "steps" not in coach.messages(cid)[0]
