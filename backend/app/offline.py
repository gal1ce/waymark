"""Built-in questions for when there is no API key: an end-of-day test and the closed-book C quizzes still
work, drawn from the topics the day actually covered. Every 'output' question here is checked by the test
suite (compiled and run with gcc), so the stored answers are what the code really prints."""
from __future__ import annotations

import json
import random
import re

from . import db

C_BANK: dict[int, list[dict]] = {
    2: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int main(void) {\n    printf("Hello");\n    printf("World\\n");\n    return 0;\n}', "answer": "HelloWorld"},
        {"type": "mcq", "prompt": "Which gcc flag turns every warning into an error?",
         "choices": ["-Wall", "-Wextra", "-Werror", "-std=c17"], "answer": "-Werror"},
        {"type": "mcq", "prompt": "What does the `#include <stdio.h>` line give the program?",
         "choices": ["The declaration of printf and other I/O functions", "A faster compiler", "The main function", "Nothing; it is a comment"],
         "answer": "The declaration of printf and other I/O functions"},
    ],
    3: [
        {"type": "output", "prompt": "What does this program print?", "code": 'printf("%d\\n", 17 / 5);', "answer": "3"},
        {"type": "output", "prompt": "What does this program print?", "code": 'printf("%d\\n", 17 % 5);', "answer": "2"},
        {"type": "output", "prompt": "What does this program print?", "code": 'printf("%.2f\\n", 7 / 2.0);', "answer": "3.50"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int i = 10;\nint j = i++ + 1;\nprintf("%d %d\\n", i, j);', "answer": "11 11"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int n = 0;\nfor (int i = 0; i < 10; i += 3) {\n    n++;\n}\nprintf("%d\\n", n);', "answer": "4"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int x = 5;\nif (x > 3 && x < 5) {\n    printf("A\\n");\n} else {\n    printf("B\\n");\n}', "answer": "B"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int d = 2;\nswitch (d) {\ncase 1:\n    printf("a");\ncase 2:\n    printf("b");\ncase 3:\n    printf("c");\n    break;\ndefault:\n    printf("d");\n}\nprintf("\\n");',
         "answer": "bc"},
    ],
    4: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int twice(int n) {\n    return n * 2;\n}\n\nint main(void) {\n    printf("%d\\n", twice(twice(3)));\n    return 0;\n}', "answer": "12"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'void bump(int n) {\n    n = n + 1;\n}\n\nint main(void) {\n    int a = 5;\n    bump(a);\n    printf("%d\\n", a);\n    return 0;\n}',
         "answer": "5"},
        {"type": "mcq", "prompt": "Why does C need a function prototype when the function is defined below main?",
         "choices": ["The compiler reads top to bottom and must know the function's type before the call",
                     "Prototypes make the function run faster", "Without it the function can't return a value",
                     "The linker can't find functions defined after main"],
         "answer": "The compiler reads top to bottom and must know the function's type before the call"},
    ],
    5: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'void bump(int *p) {\n    *p = *p + 1;\n}\n\nint main(void) {\n    int a = 5;\n    bump(&a);\n    printf("%d\\n", a);\n    return 0;\n}',
         "answer": "6"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a = 3;\nint *p = &a;\n*p = 8;\nprintf("%d\\n", a);', "answer": "8"},
        {"type": "mcq", "prompt": "What does `&x` evaluate to?",
         "choices": ["The address of x", "The value of x", "x converted to a pointer type's size", "The value pointed to by x"],
         "answer": "The address of x"},
    ],
    6: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a[5] = {4, 8, 15, 16, 23};\nint s = 0;\nfor (int i = 0; i < 5; i++) {\n    s += a[i];\n}\nprintf("%d\\n", s);',
         "answer": "66"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a[] = {1, 2, 3, 4};\nprintf("%zu\\n", sizeof a / sizeof a[0]);', "answer": "4"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a[4] = {7};\nprintf("%d %d\\n", a[0], a[3]);', "answer": "7 0"},
        {"type": "mcq", "prompt": "When you pass an array to a function, what does the function receive?",
         "choices": ["A pointer to the first element", "A full copy of the array", "The array's length", "Nothing until you return it"],
         "answer": "A pointer to the first element"},
    ],
    7: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'char s[] = "hello";\nprintf("%zu %zu\\n", strlen(s), sizeof s);', "answer": "5 6"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'char s[] = "C lang";\ns[0] = \'G\';\nprintf("%s\\n", s);', "answer": "G lang"},
        {"type": "mcq", "prompt": "What marks the end of a C string in memory?",
         "choices": ["A byte with value 0 ('\\0')", "A newline character", "Its length stored before it", "The end of the array"],
         "answer": "A byte with value 0 ('\\0')"},
    ],
    8: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'struct point {\n    int x;\n    int y;\n};\n\nint main(void) {\n    struct point p = {3, 4};\n    struct point *q = &p;\n    q->y = 10;\n    printf("%d %d\\n", p.x, p.y);\n    return 0;\n}',
         "answer": "3 10"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'struct box {\n    int w;\n};\n\nvoid grow(struct box b) {\n    b.w = 99;\n}\n\nint main(void) {\n    struct box b = {1};\n    grow(b);\n    printf("%d\\n", b.w);\n    return 0;\n}',
         "answer": "1"},
    ],
    9: [
        {"type": "mcq", "prompt": "What does fopen return when the file can't be opened?",
         "choices": ["NULL", "-1", "0 bytes", "It ends the program"], "answer": "NULL"},
        {"type": "mcq", "prompt": "Which mode string opens a file for appending text?",
         "choices": ["\"a\"", "\"w\"", "\"r\"", "\"r+\""], "answer": "\"a\""},
        {"type": "mcq", "prompt": "Why should every successful fopen be followed by fclose?",
         "choices": ["To flush buffered output and release the file handle", "To delete the file", "To make the next fopen faster", "fclose is optional and does nothing"],
         "answer": "To flush buffered output and release the file handle"},
    ],
    10: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'typedef int score;\n\nint main(void) {\n    score s = 7;\n    printf("%d\\n", s * 2);\n    return 0;\n}', "answer": "14"},
        {"type": "mcq", "prompt": "What does `typedef` create?",
         "choices": ["A new name for an existing type", "A new type with its own size", "A variable", "A macro"],
         "answer": "A new name for an existing type"},
    ],
    11: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a[] = {10, 20, 30, 40};\nint *p = a;\np += 2;\nprintf("%d\\n", *p);', "answer": "30"},
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int a[] = {5, 6, 7};\nint *p = &a[2];\nint *q = &a[0];\nprintf("%td\\n", p - q);', "answer": "2"},
        {"type": "mcq", "prompt": "If p is an int pointer, how far in memory does p + 1 move?",
         "choices": ["sizeof(int) bytes", "1 byte", "8 bytes always", "It depends on the value pointed to"],
         "answer": "sizeof(int) bytes"},
    ],
    12: [
        {"type": "output", "prompt": "What does this program print?",
         "code": 'int *p = malloc(3 * sizeof *p);\nfor (int i = 0; i < 3; i++) {\n    p[i] = i * i;\n}\nprintf("%d\\n", p[2]);\nfree(p);', "answer": "4"},
        {"type": "mcq", "prompt": "What should you do with the pointer returned by malloc before using it?",
         "choices": ["Check that it isn't NULL", "Cast it to char*", "Call free on it", "Nothing; malloc can't fail"],
         "answer": "Check that it isn't NULL"},
        {"type": "mcq", "prompt": "What happens to memory from malloc that is never freed while the program runs?",
         "choices": ["It stays allocated (a leak) until the program ends", "It is freed at the end of the function",
                     "The compiler frees it automatically", "It is moved to the stack"],
         "answer": "It stays allocated (a leak) until the program ends"},
    ],
}

KHAN_BANK: dict[int, list[dict]] = {
    0: [
        {"type": "short", "prompt": "What is this expression in its simplest form?", "math": "3(x + 4) - 2x", "answer": "x+12", "accept": ["12+x"],
         "answer_format": "an expression like 2x+5"},
        {"type": "short", "prompt": "What is the value of this expression?", "math": "2 + 3 \\cdot 4^{2}", "answer": "50", "answer_format": "a whole number"},
        {"type": "short", "prompt": "What is the value of this expression when x = 3?", "math": "x^{2} - 2x + 1", "answer": "4", "answer_format": "a whole number"},
        {"type": "short", "prompt": "What is this expression in its simplest form?", "math": "5a - 2(a - 3)", "answer": "3a+6", "accept": ["6+3a"],
         "answer_format": "an expression like 2a+5"},
    ],
    1: [
        {"type": "short", "prompt": "What value of x makes this equation true?", "math": "2x + 3 = 11", "answer": "4", "accept": ["x=4"], "answer_format": "x = ?"},
        {"type": "short", "prompt": "What value of x makes this equation true?", "math": "5x - 7 = 3x + 5", "answer": "6", "accept": ["x=6"], "answer_format": "x = ?"},
        {"type": "short", "prompt": "What is the largest whole number x that satisfies this inequality?", "math": "3x - 4 < 11", "answer": "4",
         "answer_format": "a whole number"},
        {"type": "short", "prompt": "What value of y makes this equation true?", "math": "\\frac{y}{4} + 2 = 5", "answer": "12", "accept": ["y=12"], "answer_format": "y = ?"},
    ],
    2: [
        {"type": "short", "prompt": "How many seconds are in 2.5 minutes?", "math": "", "answer": "150", "answer_format": "a whole number"},
        {"type": "short", "prompt": "A car travels 180 km in 2 hours. What is its speed in km per hour?", "math": "", "answer": "90", "answer_format": "a number"},
        {"type": "short", "prompt": "How many centimetres are in 3.2 metres?", "math": "", "answer": "320", "answer_format": "a whole number"},
    ],
    3: [
        {"type": "short", "prompt": "What is the slope of the line through these two points?", "math": "(1, 2) \\text{ and } (3, 8)", "answer": "3",
         "answer_format": "a number"},
        {"type": "short", "prompt": "What is the y-intercept of this line?", "math": "y = 4x - 7", "answer": "-7", "answer_format": "a number"},
        {"type": "short", "prompt": "What is y when x = 2 on this line?", "math": "y = -3x + 10", "answer": "4", "answer_format": "a number"},
    ],
    4: [
        {"type": "short", "prompt": "What is the slope of this line?", "math": "2x + y = 9", "answer": "-2", "answer_format": "a number"},
        {"type": "short", "prompt": "What is the slope of a line parallel to this one?", "math": "y = \\frac{1}{2}x + 3", "answer": "1/2", "accept": ["0.5"],
         "answer_format": "a fraction like 3/4"},
    ],
    5: [
        {"type": "short", "prompt": "What is x in the solution of this system?", "math": "x + y = 10,\\quad x - y = 4", "answer": "7", "accept": ["x=7"],
         "answer_format": "x = ?"},
        {"type": "short", "prompt": "What is y in the solution of this system?", "math": "y = 2x,\\quad x + y = 9", "answer": "6", "accept": ["y=6"],
         "answer_format": "y = ?"},
    ],
}

KINTSUGI_BANK = [
    {"type": "mcq", "topic": "Kintsugi · storage", "prompt": "Why do storage engines read and write whole pages instead of single records?",
     "choices": ["Disks transfer fixed-size blocks, so one page read costs about as much as one record", "Records can't be smaller than a page",
                 "The operating system forbids smaller reads", "Pages compress better"],
     "answer": "Disks transfer fixed-size blocks, so one page read costs about as much as one record"},
    {"type": "mcq", "topic": "Kintsugi · buffer pool", "prompt": "What does a buffer pool do?",
     "choices": ["Keeps recently used pages in memory so repeated reads skip the disk", "Writes every change to disk immediately",
                 "Stores the B+tree keys in sorted order", "Encrypts pages"],
     "answer": "Keeps recently used pages in memory so repeated reads skip the disk"},
    {"type": "mcq", "topic": "Kintsugi · WAL", "prompt": "Why is a change written to the write-ahead log before the data page?",
     "choices": ["So the change can be replayed after a crash", "Because the log is smaller than the page", "To sort the changes", "To free the buffer pool"],
     "answer": "So the change can be replayed after a crash"},
    {"type": "mcq", "topic": "Kintsugi · B+tree", "prompt": "Where does a B+tree keep its values?",
     "choices": ["Only in the leaf nodes", "Only in the root", "In every node", "In a separate hash table"], "answer": "Only in the leaf nodes"},
    {"type": "mcq", "topic": "Kintsugi · serialization", "prompt": "What does serializing a node mean?",
     "choices": ["Turning it into a byte layout that can be written to a page and read back", "Sorting its keys",
                 "Splitting it in two", "Giving it a unique id"],
     "answer": "Turning it into a byte layout that can be written to a page and read back"},
]


def _chapters_of(tasks: list[dict]) -> list[int]:
    out = set()
    for t in tasks:
        meta = json.loads(t["meta"]) if isinstance(t["meta"], str) else t["meta"]
        if meta.get("chapter"):
            out.add(int(meta["chapter"]))
        out |= {int(x) for x in re.findall(r"Beej (\d+)", t["title"])}
    return sorted(c for c in out if c in C_BANK)


def _tag(q: dict, topic: str) -> dict:
    out = {"topic": topic, "math": "", "code": "", "choices": [], "accept": [], "explanation": "", "answer_format": ""}
    out.update(q)
    return out


def build(ds: str, kind: str, chapters: str = "") -> list[dict]:
    """Questions for an end-of-day test ('eod') or a closed-book quiz ('c_quiz', chapters like '2-5')."""
    rnd = random.Random(f"{ds}:{kind}:{chapters}")
    picked: list[dict] = []
    if kind == "c_quiz":
        m = re.match(r"(\d+)\s*-\s*(\d+)", chapters or "")
        lo, hi = (int(m.group(1)), int(m.group(2))) if m else (2, 5)
        pool = [_tag(q, f"C · Beej {c}") for c in range(lo, hi + 1) for q in C_BANK.get(c, [])]
        rnd.shuffle(pool)
        picked = pool[:5]
    elif kind == "eod":
        tasks = db.q("SELECT title, kind, status, meta FROM tasks WHERE date=?", (ds,))
        done = [t for t in tasks if t["status"] == "done"] or tasks
        for c in _chapters_of(done)[-3:]:
            qs = C_BANK[c][:]
            rnd.shuffle(qs)
            picked += [_tag(q, f"C · Beej {c}") for q in qs[:2]]
        if any(t["kind"] in ("kintsugi_read",) for t in done):
            qs = KINTSUGI_BANK[:]
            rnd.shuffle(qs)
            picked += [_tag(q, q["topic"]) for q in qs[:3]]
        units = sorted({int((json.loads(t["meta"]) if isinstance(t["meta"], str) else t["meta"]).get("unit_idx", -1))
                        for t in done if t["kind"].startswith("khan")} - {-1})
        for u in units[:2]:
            bank = KHAN_BANK.get(u) or KHAN_BANK.get(max(k for k in KHAN_BANK if k <= u), [])
            qs = bank[:]
            rnd.shuffle(qs)
            picked += [_tag(q, "Math · Khan") for q in qs[:2]]
    else:
        return []
    picked = [dict(q) for q in picked]
    for n, q in enumerate(picked, 1):
        q["id"] = f"q{n}"
    return picked
