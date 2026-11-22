"""The CTU plan ("Real Skill + CTU Plan"): the study plan this app was first built for, as a preset.

Only plain data (strings, numbers, lists, dicts), so the same shape can later come from onboarding and live in the
database. Changing anything here changes the user's plan, so it needs their approval (COACH.md rule), and
tests/test_preset_golden.py fails until the snapshot is regenerated on purpose.

The CTU material itself (Khan units, Beej chapters, the Kintsugi reading order, English readings) lives in
curriculum.py and seed.py and is run by the CTU planner; app/modules.py says which parts of the app each module turns
on. A custom plan has the same shape plus "tracks" (see app/tracks.py)."""
from __future__ import annotations


def _week() -> list[list[dict]]:
    """Approved 2026-11-21: 9.5 h/day, Mon/Tue/Wed/Sat/Sun. The evening is C on Mon/Wed/Sun, Kintsugi otherwise."""
    out = []
    for weekday in range(7):
        evening = ("c", "C") if weekday in (0, 2, 6) else ("kintsugi", "Kintsugi")
        out.append([
            {"start": "10:00", "end": "13:00", "kind": "math", "title": "Math"},
            {"start": "13:00", "end": "14:00", "kind": "break", "title": "Lunch"},
            {"start": "14:00", "end": "15:00", "kind": "eng", "title": "English"},
            {"start": "15:00", "end": "17:00", "kind": "math", "title": "Math II"},
            {"start": "17:00", "end": "17:30", "kind": "break", "title": "Break"},
            {"start": "17:30", "end": "21:30", "kind": evening[0], "title": evening[1]},
            {"start": "21:30", "end": "22:00", "kind": "test", "title": "End-of-day test + close"},
        ])
    return out


PRESET: dict = {
    "key": "ctu",
    "engine": "ctu",
    "label": "Real Skill + CTU Plan",
    # the content modules this plan uses (app/modules.py)
    "modules": ["khan", "c", "kintsugi", "english", "repo"],
    "start_date": "2026-11-23",
    # Thursday (3) and Friday (4) are off.
    "study_weekdays": [0, 1, 2, 5, 6],
    # one list of blocks per weekday, Monday first (the off days keep a template too: the calendar shows it)
    "week": _week(),
    # minutes the planner may fill in each block (the evening is whichever of C/Kintsugi the day has)
    "block_min": {"math": 180, "eng": 60, "math2": 120, "evening": 240},
    # how much unfinished work a later block of the same kind can take when it is carried over
    "block_cap": {"c": 240, "kintsugi": 240, "eng": 65},
    "thresholds": {
        "khan_unit": {"label": "Khan unit test", "threshold": 90, "unit": "%"},
        "c_quiz": {"label": "C chapter quiz (closed book)", "threshold": 4, "max": 5},
        "book_of_proof": {"label": "Book of Proof odd-numbered", "threshold": 80, "unit": "%"},
        "pset_1806": {"label": "18.06 problem set", "threshold": 80, "unit": "%"},
        "exam_1806": {"label": "18.06 exam", "threshold": 75, "unit": "%"},
        "kintsugi_oral": {"label": "Kintsugi oral", "threshold": 8, "max": 10},
    },
    "goals": [
        {"label": "CTU FIT · SCIO", "target": "21+/30", "note": "net = right − wrong/3, 90 min · Jun 2028"},
        {"label": "IELTS", "target": "6.5", "note": "essay band 6.0 by end of Phase 1, 6.5 by Oct 2028"},
    ],
    # what a chat message is about, for practice tests the user asks for in the coach chat
    "topics": [
        {"name": "math", "pattern": r"\b(mat\w*|math\w*|algebra|cebir|denklem|equation|khan)", "flags": "i"},
        {"name": "C++", "pattern": r"(?i:\bc\+\+|\bcpp\b|\bkintsugi\b)", "flags": ""},
        {"name": "C", "pattern": r"(?<![\w#+.])C(?![\w#+])|(?i:\bc\s+(?:test|quiz|soru|sorusu|testi|dili)\b|\bbeej)", "flags": ""},
        {"name": "English", "pattern": r"\b(ingilizce|english|ielts|grammar|gramer|vocab\w*)", "flags": "i"},
    ],
    # the plan-specific parts of the prompts; the rest of each prompt is the app's own
    "coach": {
        "intro": """You are the user's study coach inside their study app. The user is following the "Real Skill + CTU Plan": turning the C/C++/ML/math claims on their LinkedIn into real skill, and applying to CTU FIT Prague in January 2029 (SCIO 21+ net out of 30, IELTS 6.5). They are a final-year high-school student.""",
        "learning_work": "C exercises, data structures, the Kintsugi/Indium rewrites, problem sets, Khan questions, summaries and essays",
        "own_work": "their Khan item, pset problem, Beej exercise",
        "practice_subjects": "math, C, English",
        "thresholds": """Thresholds: Khan unit test ≥90%; C chapters = exercises in the repo and clean with -Wall -Wextra -Werror + closed-book quiz ≥4/5; Book of Proof ≥80%; 18.06 pset ≥80%, exam ≥75%; C data structure = tests + clean ASan/valgrind + rewrite from an empty file in ≤45 min; Kintsugi oral ≥8/10; IELTS essay 6.0 by the end of Phase 1. Never count anything below its threshold as "learned/done". The server records scores; you cannot make up scores.""",
        "context": """study days are Mon/Tue/Wed/Sat/Sun 10:00–22:00 (9.5 h net); no study on Thursday and Friday. Sources: Khan Academy (English; Algebra 1 → Algebra 2 → Geometry → Precalculus), Beej's Guide to C (the coach writes the exercises), Kintsugi (a C++20 B+tree storage engine; read file by file, then rewritten without AI), English reading + summary, Sunday IELTS Task 2 essay. Study repo ~/quaimlres_road; coach file COACH.md. The next phases of the roadmap (C data structures + USACO Bronze, the Kintsugi rewrite, Khan Geometry) are already built into the app; the user switches each one on in Profile → Health. You can't approve them yourself. Khan runs inside the app (Kolibri's copy of the Khan channel): the unit's videos play in the study task, exercises use Khan's own questions and hints (mastered = 5 right of the last 7 first tries; a hint makes that try count as a miss), and the unit test is taken and graded in the app, which saves the score itself. Only a test taken on khanacademy.org needs a typed score.""",
    },
    "planner": {
        "frame": """Blocks and times are fixed (the user approved them; you cannot change them): Math 10:00–13:00 (180 min), English 14:00–15:00 (60 min), Math II 15:00–17:00 (120 min), evening 17:30–21:30 (240 min; Mon/Wed/Sun C, Tue/Sat Kintsugi). You do not write the end-of-day test block.""",
        "rules": """- Khan: unit test at the start of a unit; ≥90% → skip to the next unit. <90% → study + retest. If Algebra foundations is <50%, start with the relevant Pre-algebra units (https://www.khanacademy.org/math/pre-algebra). unit_idx = index in the Khan unit list from the context (Algebra 1 then Algebra 2, 0-based), -1 for non-Khan tasks.
- C: Beej's Guide to C. For each chapter read, WRITE 3–6 exercises (kind=exercise, one file each, files=["c/chNN/name.c"], NN = two-digit chapter number). The exercise text must be a clear job description but must NOT contain the SOLUTION, a code skeleton or hint code. Easy to hard. They must really make the user use the chapter's concepts. chapter field = chapter number (0 for non-Beej tasks).
- Kintsugi: read the files in order (kind=kintsugi_read, resources kind=kintsugi target=include/... or src/...), then an explanation + questions in cpp/kintsugi/<name>.md (kind=write). Reading questions must be specific to the file's content.
- English: reading + 5-sentence summary (write, files=["eng/..."]); Sunday IELTS Task 2 essay (40 min, files=["eng/essays/<date>.md"]).""",
    },
    "eod_rules": """- C questions: output type, code with no undefined behaviour and a single correct output. Do NOT give the solution of the user's own exercises inside a question.
- Math: 2-3 questions at the level of the unit studied on Khan, short type.""",
    "practice_rules": """- Math: short type, a number or short expression as the answer, put equivalent forms in accept.
- C and C++: output type with short code (no undefined behaviour, one correct output), or mcq about why/what happens. C++ means modern C++ (C++20), the language the user's Kintsugi project uses.
- English: mcq on grammar or vocabulary in context.""",
}
