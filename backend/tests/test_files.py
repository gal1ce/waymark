"""PROGRESS.md, COACH.md and math/log.md: the files outside the app that it writes to."""
from __future__ import annotations

import asyncio

from app import db, files, health, planner, state
from conftest import ROOT, set_now

ENTRY = ["- Saat: 1 s 0 dk", "- Notlar:\n  $\\frac{1}{2}$ and $\\sqrt{2}$ and C:\\path"]


def test_progress_new_section_has_markers():
    out = planner.progress_text("## PROGRESS\n", "2026-11-23", ENTRY)
    assert "<!-- ctu:2026-11-23 -->\n## 2026-11-23 Mon\n- Saat" in out
    assert "$\\frac{1}{2}$ and $\\sqrt{2}$ and C:\\path" in out   # #4: no escape processing


def test_progress_replace_is_exact_and_idempotent():
    first = planner.progress_text("## PROGRESS\n", "2026-11-23", ENTRY)
    hand = first + "\n## 2026-11-24 Tue\nmy own notes\n### details\nkeep me\n"
    again = planner.progress_text(hand, "2026-11-23", ["- Saat: 2 s 0 dk"])
    assert again.count("## 2026-11-23") == 1
    assert "- Saat: 2 s 0 dk" in again and "1 s 0 dk" not in again
    assert again.endswith("## 2026-11-24 Tue\nmy own notes\n### details\nkeep me\n")
    assert planner.progress_text(again, "2026-11-23", ["- Saat: 2 s 0 dk"]) == again


def test_progress_old_app_section_is_replaced_and_subsections_kept():
    old = ("## PROGRESS\n\n## 2026-11-23 Mon\n- Saat: 0 s 5 dk\n- Math: biten yok\n\n"
           "### hand-written\nkeep this\n\n## 2026-11-24 Tue\n- Saat: 1 s 0 dk\n")
    out = planner.progress_text(old, "2026-11-23", ["- Saat: 3 s 0 dk"])
    assert out.count("## 2026-11-23") == 1
    assert "### hand-written\nkeep this" in out and "0 s 5 dk" not in out
    assert "## 2026-11-24 Tue\n- Saat: 1 s 0 dk" in out


def test_progress_header_without_weekday_is_found():
    old = "## PROGRESS\n\n## 2026-11-23\nWrote this myself.\n### Sub\nx\n"
    out = planner.progress_text(old, "2026-11-23", ["- Saat: 1 s 0 dk"])
    assert out.count("## 2026-11-23") == 1, "a second section was appended"
    assert "Wrote this myself.\n### Sub\nx\n\n<!-- ctu:2026-11-23 -->\n#### Uygulama kaydı" in out
    # and the next write replaces only the app's part
    out2 = planner.progress_text(out, "2026-11-23", ["- Saat: 2 s 0 dk"])
    assert "Wrote this myself." in out2 and "2 s 0 dk" in out2 and "1 s 0 dk" not in out2


def test_write_progress_atomic_and_marked_as_own(seeded):
    p = ROOT / "repo" / "PROGRESS.md"
    p.write_text("## PROGRESS\n")
    planner.write_progress("2026-11-23")
    assert files.is_own_write(p)
    p.write_text(p.read_text() + "\nuser edit\n")
    assert not files.is_own_write(p)
    assert db.q1("SELECT 1 FROM events WHERE type='external_write'")
    assert not list(p.parent.glob(".PROGRESS.md.*.tmp"))


def test_rewrite_retries_when_the_file_changes_underneath(tmp_path):
    p = tmp_path / "f.md"
    p.write_text("a\n")
    seen = []

    def change(old):
        seen.append(old)
        if len(seen) == 1:
            p.write_text("a\nfrom an editor\n")     # someone saves between our read and our replace
        return (old or "") + "app line\n"

    files.rewrite(p, change)
    assert p.read_text() == "a\nfrom an editor\napp line\n"


# ------------------------------------------------------------------ #12 COACH.md
def test_coach_log_appends_one_tagged_line(seeded):
    before = (ROOT / "COACH.md").read_text()
    assert planner.append_coach_log("first line\nsecond line")
    after = (ROOT / "COACH.md").read_text()
    assert after.startswith(before)
    added = after[len(before):]
    assert added == "- [ctu-app 2026-11-23] first line second line\n"


def test_weekly_summary_opens_week_heading(seeded):
    set_now("2026-12-06T22:00")
    planner._weekly_summary("2026-12-06")
    text = (ROOT / "COACH.md").read_text()
    assert "\n### Hafta 1 — 30 Kasım – 6 Aralık 2026\n- [ctu-app 2026-12-06] Uygulama özeti (Hafta 1" in text
    planner._weekly_summary("2026-12-06")
    assert text.count("### Hafta 1") == 1 == (ROOT / "COACH.md").read_text().count("### Hafta 1")


def test_protected_section_change_is_reported(seeded):
    planner.append_coach_log("baseline")
    p = ROOT / "COACH.md"
    p.write_text(p.read_text().replace("≥ 90%", "≥ 70%"))
    planner.append_coach_log("next")
    assert "coach_protected" in health.warnings()


def test_missing_coach_md_is_reported(seeded):
    (ROOT / "COACH.md").unlink()
    assert not planner.append_coach_log("x")
    assert "coach_missing" in health.warnings()


# ------------------------------------------------------------------ math log (#15)
def test_math_log_one_row_per_day_and_unit():
    t = state.math_log_text(None, "2026-11-23", "Algebra foundations", 70, False)
    t = state.math_log_text(t, "2026-11-23", "Algebra foundations", 95, True)
    rows = [line for line in t.splitlines() if line.startswith("| 2026")]
    assert rows == ["| 2026-11-23 | Algebra foundations | %95 | geçti |"]


def test_score_saved_even_if_log_write_fails(seeded, monkeypatch):
    set_now("2026-11-23T10:30")
    t = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' AND kind='khan_test'")

    def boom(*a, **k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(state.files, "rewrite", boom)
    r = state.record_khan_score(t["id"], 95)
    assert r["passed"] and "could not be written" in r["message"]
    assert db.kv_get("cursor")["khan_unit"] == 1
    assert db.q1("SELECT 1 FROM scores WHERE task_id=?", (t["id"],))


def test_notes_after_close_reach_progress(seeded):
    set_now("2026-11-23T21:50")
    asyncio.run(planner.close_day("2026-11-23"))
    state.add_day_note("2026-11-23", "late thought")
    assert "late thought" in (ROOT / "repo" / "PROGRESS.md").read_text()
    state.set_day_notes("2026-11-23", "rewritten")
    text = (ROOT / "repo" / "PROGRESS.md").read_text()
    assert "rewritten" in text and "late thought" not in text


def test_passed_unit_test_ticks_off_the_study_task(seeded):
    set_now("2026-11-23T10:30")
    test = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' AND kind='khan_test'")
    study = "SELECT status, meta FROM tasks WHERE date='2026-11-23' AND title LIKE '%lessons + exercises'"
    math2 = "SELECT status FROM tasks WHERE date='2026-11-23' AND title='Math II · continue'"
    r = state.record_khan_score(test["id"], 90)
    assert r["passed"] and "isn't needed" in r["message"]
    s = db.decode(db.q1(study))
    assert s["status"] == "done" and s["meta"]["skipped"]["percent"] == 90
    assert db.q1(math2)["status"] == "todo"          # the next unit's work is not touched
    state.record_khan_score(test["id"], 70)           # a retake below the threshold needs the lessons after all
    s = db.decode(db.q1(study))
    assert s["status"] == "todo" and "skipped" not in s["meta"]
