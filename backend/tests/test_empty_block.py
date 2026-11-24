"""A block the model leaves empty keeps the planner's draft instead of showing up as 0/0 · 0 min."""
from __future__ import annotations

import asyncio
from datetime import date

from app import planner


def test_a_block_the_model_leaves_empty_keeps_the_draft(seeded, monkeypatch):
    async def structured(system, prompt, schema, effort="medium", max_tokens=16000):
        task = {"title": "Unit test (retake)", "kind": "khan_test", "est_min": 60, "detail": "", "resources": [],
                "files": [], "learning": False}
        return {"adapt_note": "x", "math": [task], "math2": [], "eng": [], "evening": []}

    monkeypatch.setattr(planner, "has_api_key", lambda: True)
    monkeypatch.setattr(planner.llm, "structured", structured)
    d = date(2026, 11, 24)
    draft = planner.template_day(d, planner._cursor())
    plan, _note = asyncio.run(planner._llm_plan(d, draft, ""))
    assert [t["title"] for t in plan["math"]] == ["Unit test (retake)"]   # what the model wrote stays
    assert plan["math2"] and plan["math2"] == draft["math2"]               # the empty block keeps the draft
    assert plan["eng"] == draft["eng"]
