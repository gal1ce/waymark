"""Week 0 seed: Monday exactly as assigned, Tue/Wed as reference versions."""
from __future__ import annotations

import json
from datetime import date

from . import db
from .config import WEEKDAY_TR, week_index
from .curriculum import beej_resource, khan_unit_resources, kintsugi_resources, schedule

VIDEO_TIP = (
    "Watch the videos **with English subtitles at 0.75x**. Write each unknown term to `eng/math-terms.md` "
    "(with its Turkish next to it). If a concept still hasn't clicked after one watch, switch to Turkish for that topic only."
)

GCC = "Must compile with no warnings under `gcc -std=c17 -Wall -Wextra -Werror file.c`. The app compiles it itself when you save the file."


def T(title, kind, est, detail="", resources=None, files=None, learning=1, meta=None):
    return {"title": title, "kind": kind, "est_min": est, "detail": detail,
            "resources": resources or [], "files": files or [], "learning": learning, "meta": meta or {}}


def c_ex(ch: int, name: str, est: int, detail: str) -> dict:
    return T(f"c/ch{ch:02d}/{name}", "exercise", est, detail + "\n\n" + GCC,
             resources=[beej_resource(ch), {"label": f"c/ch{ch:02d}/", "kind": "repo", "path": f"c/ch{ch:02d}"}],
             files=[f"c/ch{ch:02d}/{name}"], meta={"chapter": ch})


def monday() -> dict:
    return {
        "math": [
            T("Algebra foundations · unit test", "khan_test", 45,
              "Start the **unit test** here: Khan's own questions (through Kolibri), graded by the app.\n\n"
              "- **≥ 90%** → unit passed, move to the next unit in Math II.\n"
              "- **< 90%** → go to the study task below, then retake the test.\n"
              "- **< 50%** → the gap is before Algebra 1; the agent will point you to Pre-algebra.\n\n"
              "The score is saved and written to `math/log.md` automatically.",
              khan_unit_resources(0), meta={"unit_idx": 0, "score_kind": "khan_unit"}),
            T("Algebra foundations · lessons + exercises", "khan_study", 135,
              "Only if the unit test is below 90%. Watch the unit's videos in order and work each exercise "
              "here until it's **mastered** (5 of the last 7 right, Khan's rule).\n\n" + VIDEO_TIP,
              khan_unit_resources(0), meta={"unit_idx": 0}),
        ],
        "eng": [
            T("Spolsky · read the Unicode article", "read", 40,
              "You can look up single words; no translating sentences or paragraphs. "
              "If it's too heavy, read half and summarize that half.",
              [{"label": "Joel Spolsky · The Absolute Minimum… Unicode", "kind": "url",
                "href": "https://www.joelonsoftware.com/2003/10/08/the-absolute-minimum-every-software-developer-absolutely-positively-must-know-about-unicode-and-character-sets-no-excuses/"}]),
            T("Summary · Spolsky (5 sentences)", "write", 20,
              "In your own words, in English, 5 sentences. File: `eng/2026-11-23-spolsky.md`.",
              [{"label": "eng/", "kind": "repo", "path": "eng"}], files=["eng/2026-11-23-spolsky.md"]),
        ],
        "math2": [
            T("Math II · continue", "khan_study", 120,
              "- If the morning unit test was **≥ 90%** → start with the **Solving equations & inequalities** unit test, same rule.\n"
              "- If **< 90%** → keep studying Algebra foundations, then retake the unit test.\n\n" + VIDEO_TIP,
              khan_unit_resources(1) + [{"label": "eng/math-terms.md", "kind": "repo", "path": "eng/math-terms.md"}],
              meta={"unit_idx": 1, "score_kind": "khan_unit"}),
        ],
        "c": [
            T("Beej 1 (1.1–1.3) + Beej 2 (skip 2.5–2.6)", "read", 35,
              "1.4–1.9 are contact/license pages, skip them. Also skip 2.5 clang and 2.6 IDE; you use gcc.",
              [beej_resource(1), beej_resource(2)]),
            T("Beej 3 · Variables and Statements", "read", 50, "", [beej_resource(3)]),
            c_ex(2, "hello.c", 10, "A program that prints your name and age on two separate lines."),
            c_ex(2, "errors.c", 20,
                 "Copy hello.c. One at a time, make a **single** mistake: (1) delete the semicolon, "
                 "(2) write `prinf` instead of `printf`, (3) delete the `#include` line. Each time, write the compiler's error "
                 "as a comment at the top of the file, with its meaning in your own words. The final version must have no errors."),
            c_ex(3, "temp.c", 20, "Print a table of Celsius values from 0 to 100 in steps of 10 with their Fahrenheit equivalents. 1 decimal place."),
            c_ex(3, "sums.c", 15, "The sum of the numbers 1–100 and the sum of the even numbers in the same range. With `while`, no `for`."),
            c_ex(3, "fizzbuzz.c", 15, "1–50: Fizz for multiples of 3, Buzz for multiples of 5, FizzBuzz for both, the number otherwise."),
            c_ex(3, "time.c", 15, "`int seconds = 98765;` → hours:minutes:seconds (`/` and `%`)."),
            c_ex(3, "division.c", 20, "Print the results of `7/2`, `7.0/2`, `(float)7/2`, `7%2`, `-7/2`, `-7%2`; next to each, write why as a comment."),
            c_ex(3, "table.c", 20, "1–10 multiplication table, nested `for`, columns aligned."),
            c_ex(3, "day.c", 15, "For `int day = 3;` print the day's Turkish name with `switch`; outside 1–7 print \"geçersiz\"."),
        ],
        "test": [
            T("End-of-day test", "test", 25, "From today's topics and your sticking points. Closed book, 30 min.", learning=0),
            T("Close the day + git push", "other", 5,
              "The app writes the day's record to `PROGRESS.md`. You run `git add -A && git commit && git push`.",
              [{"label": "PROGRESS.md", "kind": "repo", "path": "PROGRESS.md"}], learning=0),
        ],
    }


KHAN_REF_NOTE = "Reference version: the agent will rewrite this task based on Monday's results."


def tuesday() -> dict:
    return {
        "math": [T("Khan · next unit (unit test → study)", "khan_study", 180,
                   KHAN_REF_NOTE + "\n\nExpected: Solving equations & inequalities.\n\n" + VIDEO_TIP,
                   khan_unit_resources(1), meta={"unit_idx": 1, "score_kind": "khan_unit"})],
        "eng": [
            T("Wikipedia · B+ tree (intro + Structure)", "read", 35,
              "Prep for the evening Kintsugi reading. Looking up words is fine, no sentence translation.",
              [{"label": "en.wikipedia.org · B+ tree", "kind": "url", "href": "https://en.wikipedia.org/wiki/B%2B_tree"}]),
            T("Summary · B+ tree (5 sentences)", "write", 25, "File: `eng/2026-11-24-btree.md`.",
              [{"label": "eng/", "kind": "repo", "path": "eng"}], files=["eng/2026-11-24-btree.md"]),
        ],
        "math2": [T("Khan · continue", "khan_study", 120, KHAN_REF_NOTE + "\n\n" + VIDEO_TIP,
                    khan_unit_resources(2), meta={"unit_idx": 2, "score_kind": "khan_unit"})],
        "kintsugi": [
            T("Read disk_manager.h", "kintsugi_read", 40,
              "Focus on comments and signatures, not the code: what does the class do, who calls it?",
              kintsugi_resources(["include/disk_manager.h"])),
            T("Read disk_manager.cpp", "kintsugi_read", 80,
              "For each function: what goes in, what it does to the file, what happens on error?",
              kintsugi_resources(["src/disk_manager.cpp"])),
            T("cpp/kintsugi/disk_manager.md · explanation + 6 questions", "write", 80,
              "Without looking at the code, 1 paragraph: what DiskManager does. Then answer these in your own words:\n\n"
              "1. Why is PAGE_SIZE 4096?\n2. Which file offset does a page_id map to? Write the formula.\n"
              "3. How is `_next_page_id` computed when the file is opened?\n4. What happens if `read_page` gets a buffer shorter than 4096?\n"
              "5. What happens if you read a page that hasn't been written yet?\n6. What does the constructor do if the database file doesn't exist?",
              [{"label": "cpp/kintsugi/", "kind": "repo", "path": "cpp/kintsugi"}], files=["cpp/kintsugi/disk_manager.md"]),
            T("CMU 15-445 · Database Storage lecture", "read", 40,
              "Open the storage (disk/page) lecture from the course page, first 40 minutes. See where Kintsugi's page idea comes from.",
              [{"label": "CMU 15-445", "kind": "url", "href": "https://15445.courses.cs.cmu.edu/"}]),
        ],
        "test": monday()["test"],
    }


def wednesday() -> dict:
    return {
        "math": [T("Khan · next unit", "khan_study", 180, KHAN_REF_NOTE + "\n\n" + VIDEO_TIP,
                   khan_unit_resources(2), meta={"unit_idx": 2, "score_kind": "khan_unit"})],
        "eng": [
            T("Wikipedia · Pointer (computer programming) — intro", "read", 35,
              "Prep for Beej 5 in the evening.",
              [{"label": "en.wikipedia.org · Pointer", "kind": "url",
                "href": "https://en.wikipedia.org/wiki/Pointer_(computer_programming)"}]),
            T("Summary · Pointer (5 sentences)", "write", 25, "File: `eng/2026-11-25-pointer.md`.",
              [{"label": "eng/", "kind": "repo", "path": "eng"}], files=["eng/2026-11-25-pointer.md"]),
        ],
        "math2": [T("Khan · continue", "khan_study", 120, KHAN_REF_NOTE, khan_unit_resources(3),
                    meta={"unit_idx": 3, "score_kind": "khan_unit"})],
        "c": [
            T("Beej 4 · Functions", "read", 40, "", [beej_resource(4)]),
            c_ex(4, "power.c", 20, "`int power(int base, int exp)` with a loop. Print 2^10, 3^5, 7^0."),
            c_ex(4, "prototype.c", 15, "Call a function defined below main without a prototype; write the error as a comment, then fix it with a prototype."),
            c_ex(4, "swap_fail.c", 15, "Try to swap two numbers with `void swap(int a, int b)`; print before/after in main. Write why it doesn't work as a comment."),
            c_ex(4, "primes.c", 20, "`int is_prime(int n)`; print the primes below 100."),
            T("Beej 5 · Pointers", "read", 50, "", [beej_resource(5)]),
            c_ex(5, "swap.c", 15, "Make the swap from swap_fail.c work with pointers."),
            c_ex(5, "addr.c", 20, "Declare an int, a double and a char; print their values, addresses (`%p`) and `sizeof`s. Comment on what you see."),
            c_ex(5, "minmax.c", 20, "`void min_max(int a, int b, int c, int *min, int *max)`."),
            c_ex(5, "null.c", 20, "Dereference a NULL pointer, run it, write what happened as a comment. Then add a NULL check before the deref."),
        ],
        "test": monday()["test"],
    }


FALLBACK_TESTS = {
    "2026-11-23": [
        {"id": "q1", "type": "output", "topic": "C · Beej 3", "prompt": "What does it print?",
         "code": 'printf("%d\\n", 7 / 2);', "answer": "3"},
        {"id": "q2", "type": "output", "topic": "C · Beej 3", "prompt": "What does it print?",
         "code": 'printf("%d\\n", -7 % 2);', "answer": "-1"},
        {"id": "q3", "type": "output", "topic": "C · Beej 3", "prompt": "What does it print?",
         "code": 'printf("%.1f\\n", (float)7 / 2);', "answer": "3.5"},
        {"id": "q4", "type": "output", "topic": "C · Beej 3", "prompt": "What does it print?",
         "code": "int i = 0;\nwhile (i < 5) i += 2;\nprintf(\"%d\", i);", "answer": "6"},
        {"id": "q5", "type": "output", "topic": "C · switch", "prompt": "What does it print?",
         "code": 'int d = 2;\nswitch (d) {\n  case 1: printf("a");\n  case 2: printf("b");\n  case 3: printf("c"); break;\n  default: printf("d");\n}',
         "answer": "bc"},
        {"id": "q6", "type": "mcq", "topic": "C · gcc", "prompt": "Which gcc flag turns warnings into errors?",
         "choices": ["-Wall", "-Wextra", "-Werror", "-std=c17"], "answer": "-Werror"},
        {"id": "q7", "type": "mcq", "topic": "English · Spolsky", "prompt": "How many bytes does the letter 'A' take in UTF-8?",
         "choices": ["1", "2", "4", "It varies, can't tell"], "answer": "1"},
        {"id": "q8", "type": "mcq", "topic": "English · Spolsky",
         "prompt": "What does Spolsky mean by \"There Ain't No Such Thing As Plain Text\"?",
         "choices": ["To read a text correctly you need to know its encoding", "Plain text files aren't used anymore",
                     "ASCII covers every language", "Unicode is a file format"],
         "answer": "To read a text correctly you need to know its encoding"},
        {"id": "q9", "type": "short", "topic": "Math · Algebra foundations", "prompt": "Simplify: 3(x + 4) − 2x",
         "answer": "x+12", "accept": ["x+12", "12+x"]},
        {"id": "q10", "type": "short", "topic": "Math · Algebra foundations", "prompt": "If 2x + 3 = 11, x = ?",
         "answer": "4", "accept": ["4", "x=4"]},
    ]
}


def _insert_day(d: date, plan: dict, version: str = "reference", title: str | None = None) -> None:
    ds = d.isoformat()
    db.ex("INSERT OR REPLACE INTO days(date,week,kind,version,status,title,created_at) VALUES(?,?,?,?,?,?,?)",
          (ds, week_index(d), "study", version, "planned", title or WEEKDAY_TR[d.weekday()], db.ts()))
    insert_tasks(d, plan)


def insert_tasks(d: date, plan: dict) -> None:
    """Plan keys are the block kinds of the approved schedule, with a number for the second and later block of the
    same kind on a day (CTU: math, eng, math2, c|kintsugi, test)."""
    ds = d.isoformat()
    from . import tracks
    blocks = tracks.day_blocks(d)   # the schedule, with a custom plan's exam dates applied; read before the delete
    db.ex("DELETE FROM tasks WHERE date=?", (ds,))
    db.ex("DELETE FROM blocks WHERE date=?", (ds,))
    seen: dict[str, int] = {}
    for ord_, b in enumerate(blocks):
        bid = db.ex("INSERT INTO blocks(date,ord,start,end,kind,title) VALUES(?,?,?,?,?,?)",
                    (ds, ord_, b["start"], b["end"], b["kind"], b["title"]))
        n = seen[b["kind"]] = seen.get(b["kind"], 0) + 1
        key = b["kind"] if n == 1 else f"{b['kind']}{n}"
        for i, t in enumerate(plan.get(key, [])):
            db.ex("INSERT INTO tasks(date,block_id,ord,title,detail,kind,learning,resources,files,est_min,meta) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                  (ds, bid, i, t["title"], t.get("detail", ""), t["kind"], int(t.get("learning", 1)),
                   json.dumps(t.get("resources", []), ensure_ascii=False),
                   json.dumps(t.get("files", []), ensure_ascii=False),
                   int(t.get("est_min", 30)), json.dumps(t.get("meta", {}), ensure_ascii=False)))


def seed_if_empty() -> bool:
    """The CTU plan's first three days, exactly as they were assigned. Other plans start from their own planner."""
    from . import profile
    if not profile.is_ctu() or db.q1("SELECT 1 FROM days LIMIT 1"):
        return False
    _insert_day(date(2026, 11, 23), monday(), version="adapted")
    _insert_day(date(2026, 11, 24), tuesday())
    _insert_day(date(2026, 11, 25), wednesday())
    db.kv_set("cursor", {"khan_unit": 0, "beej_next": 6, "kintsugi_idx": 1})
    db.kv_set("fallback_tests", FALLBACK_TESTS)
    return True
