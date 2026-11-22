"""Static curriculum: ordered resources the planner walks through, plus the
approved daily schedule. Changing anything here changes the plan, so it needs
the user's approval (COACH.md rule)."""
from __future__ import annotations

from . import profile

KHAN_BASE = "https://www.khanacademy.org/math/algebra"
KHAN_A1 = "x2f8bb11595b61c86"
KHAN_BASE2 = "https://www.khanacademy.org/math/algebra2"
KHAN_A2 = "x2ec2f6f830c9fb89"

# Algebra 1 units in Khan's order. Slugs were written from memory; the course
# link is always shown next to them in case one has moved.
KHAN_ALGEBRA1 = [
    ("Algebra foundations", "foundation-algebra"),
    ("Solving equations & inequalities", "solve-equations-inequalities"),
    ("Working with units", "working-units"),
    ("Linear equations & graphs", "linear-equations-graphs"),
    ("Forms of linear equations", "forms-of-linear-equations"),
    ("Systems of equations", "systems-of-equations"),
    ("Inequalities (systems & graphs)", "inequalities-systems-graphs"),
    ("Functions", "functions"),
    ("Sequences", "sequences"),
    ("Absolute value & piecewise functions", "absolute-value-piecewise-functions"),
    ("Exponents & radicals", "exponents-radicals"),
    ("Exponential growth & decay", "exponential-growth-decay"),
    ("Quadratics: Multiplying & factoring", "quadratics-multiplying-factoring"),
    ("Quadratic functions & equations", "quadratic-functions-equations"),
    ("Irrational numbers", "irrational-numbers"),
    ("Creativity in algebra", "creativity-in-algebra"),
]

# Algebra 2 comes next in the approved roadmap (COACH.md: "Kas–Ara 26: Khan Algebra 1→2").
# Slugs from memory as well; the course link is shown next to each unit.
KHAN_ALGEBRA2 = [
    ("Polynomial arithmetic", "poly-arithmetic"),
    ("Complex numbers", "complex"),
    ("Polynomial factorization", "poly-factor"),
    ("Polynomial division", "poly-div"),
    ("Polynomial graphs", "poly-graphs"),
    ("Rational exponents and radicals", "rational-exponents-and-radicals"),
    ("Exponential models", "exp-models"),
    ("Logarithms", "logs"),
    ("Transformations of functions", "transformations"),
    ("Equations", "equations"),
    ("Trigonometry", "trig"),
    ("Modeling", "modeling"),
]

# One list the planner walks through; cursor["khan_unit"] indexes it.
KHAN_UNITS = ([{"course": "Algebra 1", "name": n, "href": f"{KHAN_BASE}/{KHAN_A1}:{s}", "course_href": KHAN_BASE}
               for n, s in KHAN_ALGEBRA1] +
              [{"course": "Algebra 2", "name": n, "href": f"{KHAN_BASE2}/{KHAN_A2}:{s}", "course_href": KHAN_BASE2}
               for n, s in KHAN_ALGEBRA2])


# Geometry follows in the roadmap (COACH.md: "Oca–Şub 27: Khan Geometry+Precalc"). It is a next phase:
# the planner only moves into it after the user approves "khan_geometry". Unit links point at the course
# page (unit slugs weren't verified).
KHAN_GEO = "https://www.khanacademy.org/math/geometry"
KHAN_GEOMETRY = ["Performing transformations", "Transformation properties and proofs", "Congruence", "Similarity",
                 "Right triangles & trigonometry", "Analytic geometry", "Conic sections", "Circles", "Solid geometry"]
KHAN_ALGEBRA_COUNT = len(KHAN_UNITS)
KHAN_UNITS += [{"course": "Geometry", "name": n, "href": KHAN_GEO, "course_href": KHAN_GEO, "phase": "khan_geometry"}
               for n in KHAN_GEOMETRY]


def khan_unit(idx: int) -> dict:
    return KHAN_UNITS[max(0, min(idx, len(KHAN_UNITS) - 1))]


def khan_item(idx: int) -> str:
    """The name a unit's scores are stored under, e.g. 'Algebra 1 · Functions'."""
    u = khan_unit(idx)
    return f"{u['course']} · {u['name']}"


def khan_unit_resources(idx: int) -> list[dict]:
    u = khan_unit(idx)
    return [
        {"label": f"Khan · {u['name']}", "kind": "url", "href": u["href"]},
        {"label": f"Khan · {u['course']} course", "kind": "url", "href": u["course_href"]},
        {"label": "math/log.md", "kind": "repo", "path": "math/log.md"},
    ]


BEEJ = "https://beej.us/guide/bgc/html/split/"
BEEJ_CHAPTERS = [
    (1, "Foreword", "foreword.html"),
    (2, "Hello, World!", "hello-world.html"),
    (3, "Variables and Statements", "variables-and-statements.html"),
    (4, "Functions", "functions.html"),
    (5, "Pointers—Cower In Fear!", "pointers.html"),
    (6, "Arrays", "arrays.html"),
    (7, "Strings", "strings.html"),
    (8, "Structs", "structs.html"),
    (9, "File Input/Output", "file-inputoutput.html"),
    (10, "typedef: Making New Types", "typedef-making-new-types.html"),
    (11, "Pointers II: Arithmetic", "pointers2.html"),
    (12, "Manual Memory Allocation", "manual-memory-allocation.html"),
]


def beej_resource(ch: int) -> dict:
    n, title, page = BEEJ_CHAPTERS[ch - 1]
    return {"label": f"Beej {n} · {title}", "kind": "url", "href": BEEJ + page}


KINTSUGI_ORDER = [
    ["include/disk_manager.h", "src/disk_manager.cpp"],
    ["include/buffer_pool.h", "src/buffer_pool.cpp"],
    ["include/serializer.h", "src/serializer.cpp"],
    ["include/btree_node.h", "src/btree_node.cpp"],
    ["include/wal_record.h", "src/wal_manager.cpp"],
    ["include/key_map.h", "src/key_map.cpp", "include/store.h", "src/store.cpp"],
    ["include/auth.h", "src/auth.cpp", "include/kintsugi.h", "src/kintsugi.cpp"],
    ["include/cli.h", "src/cli.cpp", "src/main.cpp"],
]


def kintsugi_resources(files: list[str]) -> list[dict]:
    res = [{"label": f"Kintsugi · {f}", "kind": "kintsugi", "path": f} for f in files]
    res.append({"label": "CMU 15-445 (lecture videos)", "kind": "url",
                "href": "https://15445.courses.cs.cmu.edu/"})
    return res


def schedule(weekday: int) -> list[dict]:
    """The blocks of a weekday, from the active plan (app/profile.py)."""
    return profile.week(weekday)


C_COMPILE = ["gcc", "-std=c17", "-Wall", "-Wextra", "-Werror"]

# Beej chapters this phase covers (COACH.md roadmap: "Beej 1–12" in Nov–Dec). Past it the C evenings
# review earlier chapters until the next phase is approved.
BEEJ_LAST = len(BEEJ_CHAPTERS)
RUNWAY_WARN_DAYS = 7


# ------------------------------------------------------------------ next phases
# What comes after this phase's material, taken from the roadmap in COACH.md. Each is OFF until the user
# approves it (kv "approved_phases"; Health panel or POST /api/phases/<key>/approve), because the plan
# doesn't change without their approval. Until then the evenings review and a warning asks for a decision.
PHASES = {
    "c_ds": {
        "track": "c", "label": "C data structures + USACO Bronze",
        "what": "C evenings (Mon/Wed): dynamic array, linked list, stack, queue, then BST, merge sort, quicksort; "
                "each built in c/ds/, tested clean under ASan, then rewritten from an empty file in ≤45 min. "
                "Sunday C block: USACO Bronze in C++ (usaco-guide/).",
        "roadmap": "COACH.md: USACO Bronze starts on the Sunday C block when Beej 1–12 is done; Jan–Feb 27 C dynamic "
                   "array/linked list/stack/queue; Mar–May BST/MergeSort/QuickSort.",
    },
    "kintsugi_rewrite": {
        "track": "kintsugi", "label": "Kintsugi rewrite",
        "what": "Kintsugi evenings: rewrite page I/O, the buffer pool, the serializer, the B+tree node and the WAL from "
                "your notes in cpp/kintsugi/rewrite/ (header, implementation, tests + compare with the original).",
        "roadmap": "COACH.md: Jan–Feb 27 rewrite page I/O + buffer pool; Mar–May B+tree + WAL rewrite done.",
    },
    "khan_geometry": {
        "track": "khan", "label": "Khan Geometry",
        "what": "After Algebra 2, the morning Khan blocks continue with the Geometry course, unit by unit (test first, "
                "≥90% to pass).",
        "roadmap": "COACH.md: Jan–Feb 27 Khan Geometry + Precalc.",
    },
}

WIKI = "https://en.wikipedia.org/wiki/"
C_DS = [
    ("Dynamic array", "dynarray", WIKI + "Dynamic_array"),
    ("Singly linked list", "linked_list", WIKI + "Linked_list"),
    ("Stack", "stack", WIKI + "Stack_(abstract_data_type)"),
    ("Queue", "queue", WIKI + "Queue_(abstract_data_type)"),
    ("Binary search tree", "bst", WIKI + "Binary_search_tree"),
    ("Merge sort", "merge_sort", WIKI + "Merge_sort"),
    ("Quicksort", "quicksort", WIKI + "Quicksort"),
]
# Two evenings per structure: build + test it, then rewrite it from an empty file against the clock.
C_DS_SESSIONS = [(i, step) for i in range(len(C_DS)) for step in ("build", "rewrite")]
USACO_BRONZE = "https://usaco.guide/bronze/"

REWRITE_GROUPS = [
    ("disk_manager", "page I/O"), ("buffer_pool", "buffer pool"), ("serializer", "serializer"),
    ("btree_node", "B+tree node"), ("wal", "write-ahead log"),
]
REWRITE_STEPS = ("header", "implement", "test")
REWRITE_SESSIONS = [(g, step) for g in range(len(REWRITE_GROUPS)) for step in REWRITE_STEPS]


def runway(cursor: dict, start, next_study_day, horizon: int = 60, approved: set | None = None) -> dict:
    """How many study days of NEW material each track has left, walking the planner's own pace from `start`
    (C: 2 Beej chapters per C evening, 1 on Sunday, then one data-structure session per evening if that phase
    is approved; Kintsugi: one file group per evening, then one rewrite session if approved). Khan pace depends
    on test results, so it is reported as units left."""
    approved = approved or set()
    beej, kin = cursor.get("beej_next", 6), cursor.get("kintsugi_idx", 1)
    ds, rw = cursor.get("ds_idx", 0), cursor.get("rewrite_idx", 0)
    c_days = k_days = None
    d, n = start, 0
    while n < horizon and (c_days is None or k_days is None):
        d = next_study_day(d)
        n += 1
        if schedule(d.weekday())[5]["kind"] == "c":
            if c_days is None:
                if beej <= BEEJ_LAST:
                    beej += 1 if d.weekday() == 6 else 2
                elif "c_ds" in approved and ds < len(C_DS_SESSIONS):
                    ds += 0 if d.weekday() == 6 else 1     # Sunday is USACO
                else:
                    c_days = n - 1
        elif k_days is None:
            if kin <= len(KINTSUGI_ORDER) - 1:
                kin += 1
            elif "kintsugi_rewrite" in approved and rw < len(REWRITE_SESSIONS):
                rw += 1
            else:
                k_days = n - 1
    limit = len(KHAN_UNITS) if "khan_geometry" in approved else KHAN_ALGEBRA_COUNT
    return {"c_days": c_days, "kintsugi_days": k_days,
            "khan_units_left": max(0, limit - cursor.get("khan_unit", 0)), "horizon": horizon}
