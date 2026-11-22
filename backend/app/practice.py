"""Practice tests asked for in chat. Reading the request is deterministic (regexes, no model), so it works the same
with any chat model; the level and what the generator is told about earlier tests are decided here too."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import timedelta

from . import db, profile
from .config import now

COUNT_MIN, COUNT_MAX, COUNT_DEFAULT = 3, 15, 6
MAX_PER_TURN = 3
LEVELS = ("easy", "medium", "hard")
MIN_PER_Q = {"easy": 2, "medium": 3, "hard": 4}
LEVEL_TEXT = {
    "easy": "a step below the user's current level. Warm-up questions: one idea each, one or two steps, friendly numbers; "
            "they check that the basics are solid.",
    "medium": "at the user's current level, like a typical exercise from the unit or chapter they are on now: "
              "two or three steps, one main idea per question.",
    "hard": "at the top of the user's current level. Multi-step questions (three or more steps), questions that combine two "
            "ideas, less familiar setups, mcq distractors built from the common mistakes. No warm-ups. Each one still solvable "
            "by hand in about 3-4 minutes and still inside the requested topics.",
}

# ------------------------------------------------------------------ reading the message
_TEST_W = re.compile(r"\b(test|quiz|s[ıi]nav)", re.I)
_MAKE_W = re.compile(r"(olu[şs]tur|haz[ıi]rla|[üu]ret|\byap\b|\byapar\s*m[ıi]s[ıi]n|\bver\b|\bverir\s*m[ıi]s[ıi]n|\bekle\b|\bkoy\b|"
                     r"sayfas[ıi]na|\bcreate\b|\bmake\b|\bgenerate\b|\bbuild\b|\bprepare\b|\bgive me\b|\bset up\b|\bto the tests? page)", re.I)
_NOT_PRACTICE = re.compile(r"(g[üu]n\s*sonu|end[- ]of[- ]day|\beod\b|kapal[ıi] kitap|closed[- ]book)", re.I)
_ASK_Q = re.compile(r"soru\s*sor|\bask\s+(?:you\s+)?(?:a\s+|some\s+|more\s+)?questions?", re.I)

_FOLD = str.maketrans("üçöşığÜÇÖŞİĞ", "ucosigUCOSIG")
_TR_ONES = {"bir": 1, "iki": 2, "üç": 3, "dört": 4, "beş": 5, "altı": 6, "yedi": 7, "sekiz": 8, "dokuz": 9}
_TR = {**_TR_ONES, "on": 10, "yirmi": 20, **{f"on {k}": 10 + v for k, v in _TR_ONES.items()}}
_TR |= {k.translate(_FOLD): v for k, v in _TR.items()}
_EN = {w: i for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                                  "sixteen seventeen eighteen nineteen twenty".split(), 1)}


def _alt(words: dict[str, int]) -> str:
    return "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in sorted(words, key=len, reverse=True))


_ADJ = r"(?:\S+\s+){0,2}?"   # up to two words between the number and "soru": "10 tane daha zor soru"
_COUNT_TR = re.compile(rf"(?<![\w.])(\d{{1,2}}|(?:{_alt(_TR)})\b)\s*(?:tane\s+)?(?:daha\s+)?{_ADJ}soru", re.I)
_COUNT_EN = re.compile(rf"(?<![\w.])(\d{{1,2}}|(?:{_alt(_EN)})\b)[\s-]*(?:more\s+)?{_ADJ}(?:questions?\b|qs?\b)", re.I)

_HARDER = re.compile(r"\bdaha\s+(?:da\s+)?(?:\S+\s+)?zor\b|\bdaha\s+zorlay|\bzorla[şs]t\w*|\bbir\s+t[ıi]k\s+(?:daha\s+)?zor|"
                     r"\bharder\b|\bmore\s+(?:difficult|challenging)\b|\btougher\b", re.I)
_EASIER = re.compile(r"\bdaha\s+(?:da\s+)?(?:\S+\s+)?(?:kolay|basit)\b|\bkolayla[şs]t\w*|\beasier\b|\bsimpler\b|\bless\s+difficult\b", re.I)
_HARD = re.compile(r"\b(zor|zorlay[ıi]c[ıi]|ileri\s+seviye|hard|difficult|challenging|advanced|tough)\b", re.I)
_EASY = re.compile(r"\b(kolay|basit|[ıi]s[ıi]nma|easy|simple|beginner|warm[- ]?up)\b", re.I)
_MEDIUM = re.compile(r"\b(orta(?:\s+seviye)?|medium|intermediate)\b", re.I)

_MORE = re.compile(
    rf"(?<![\w.])(?:\d{{1,2}}|(?:{_alt(_TR)})\b)\s*(?:tane\s+)?daha\s+(?:\S+\s+){{0,2}}?(?:soru|test|quiz|s[ıi]nav)"
    r"|\bbir\s+(?:\S+\s+){0,2}?(?:test|quiz|s[ıi]nav)\w*\s+daha\b"
    r"|\bdaha\s+(?:da\s+)?(?:zor|kolay|basit|fazla|[çc]ok)\w*\s+(?:\S+\s+){0,2}?(?:soru|test|quiz|s[ıi]nav)"
    r"|\b(?:another|one\s+more)\s+(?:\S+\s+){0,2}?(?:test|quiz)"
    r"|\b\d{1,2}\s+more\s+(?:\S+\s+){0,2}?questions?"
    r"|\b(?:harder|easier|tougher)\s+(?:\S+\s+){0,2}?(?:test|quiz|questions?)", re.I)
_REF_ID = re.compile(r"#\s*(\d+)\b|\b(\d+)\s*numaral[ıi]\s+(?:test|quiz|s[ıi]nav)", re.I)
_FIRST = re.compile(r"\b(ilk|birinci|first)\s+(?:test|quiz|s[ıi]nav)", re.I)
_PREV = re.compile(r"\b([öo]nceki|son|demin\w*|az\s+[öo]nceki|previous|last|that)\s+(?:test|quiz|s[ıi]nav)", re.I)

_PLURAL = re.compile(r"\b(testler\w*|quizler\w*|s[ıi]navlar\w*|tests|quizzes)\b", re.I)
_N_TESTS = re.compile(r"\b(2|3|iki|[üu][çc]|two|three)\s+(?:tane\s+|ayr[ıi]\s+|farkl[ıi]\s+|different\s+|separate\s+)*"
                      r"(?:\S+\s+)?(?:test|quiz|s[ıi]nav)", re.I)
_SPLIT = re.compile(r"\s*(?:[,;]|\bve\b|\band\b|\bile\b|\bayr[ıi]ca\b|\bplus\b)\s*", re.I)


def topics_in(text: str) -> list[str]:
    return [name for name, rx in profile.topics() if rx.search(text)]


def _count(text: str) -> int | None:
    for rx, words in ((_COUNT_TR, _TR), (_COUNT_EN, _EN)):
        for m in rx.finditer(text):
            w = re.sub(r"\s+", " ", m.group(1).lower())
            n = int(w) if w.isdigit() else words.get(w, words.get(w.translate(_FOLD)))
            if n and n > 1:          # "bir soru" / "one question" is an article, not a count
                return n
    return None


def _level(text: str) -> tuple[str | None, int]:
    """(absolute level, shift): 'zor' → ('hard', 0); 'daha zor' → (None, +1)."""
    if _HARDER.search(text):
        return None, 1
    if _EASIER.search(text):
        return None, -1
    if _HARD.search(text):
        return "hard", 0
    if _EASY.search(text):
        return "easy", 0
    if _MEDIUM.search(text):
        return "medium", 0
    return None, 0


@dataclass
class Intent:
    topics: list[str] = field(default_factory=list)
    label: str = ""                  # topics as the user/model wrote them, when richer than the canonical names
    count: int | None = None         # what was asked for, before limits
    level: str | None = None         # easy | medium | hard, None = choose
    shift: int = 0                   # +1 harder / -1 easier than the base test
    ref: int | str | None = None     # test id, 'first' or 'last' (of this conversation)
    copy: int = 0                    # "two math tests": copies 0, 1, ...


def parse(text: str, history: list[dict]) -> list[Intent]:
    """The practice tests one chat message asks for (at most MAX_PER_TURN); [] when it doesn't ask for one."""
    asks = _TEST_W.search(text) and _MAKE_W.search(text)
    more = _MORE.search(text) and not _ASK_Q.search(text)
    if not (asks or more) or _NOT_PRACTICE.search(text):
        return []
    ref: int | str | None = None
    if m := _REF_ID.search(text):
        ref = int(m.group(1) or m.group(2))
    elif _FIRST.search(text):
        ref = "first"
    elif more or _PREV.search(text):
        ref = "last"
    level, shift = _level(text)
    if shift:
        ref = ref or "last"

    # one test per part with its own topics, when the message clearly asks for several
    parts = [text]
    if _PLURAL.search(text) or len(_TEST_W.findall(text)) > 1:
        parts = [p for p in _SPLIT.split(text) if p.strip()]
    with_topics = [p for p in parts if topics_in(p)]
    if len(with_topics) < 2:
        with_topics = [text] if topics_in(text) else []
    loose = " ".join(p for p in parts if p not in with_topics) if len(with_topics) > 1 else text
    count_all = _count(loose) or _count(text)

    out: list[Intent] = []
    for p in with_topics or [""]:
        lv, sh = _level(p) if p else (None, 0)
        if not lv and not sh:
            lv, sh = level, shift
        out.append(Intent(topics=topics_in(p) if p else [], count=(_count(p) if p and len(with_topics) > 1 else None) or count_all,
                          level=lv, shift=sh, ref=ref))
    if len(out) == 1 and (m := _N_TESTS.search(text)):
        n = {"2": 2, "iki": 2, "two": 2}.get(m.group(1).lower(), 3)
        out = [Intent(**{**out[0].__dict__, "copy": i}) for i in range(n)]
    if not out[0].topics and len(out) == 1 and ref is None:
        # "make a test" right after "let's do math and C": the topics come from the previous message
        prev = next((m["content"] for m in reversed(history) if m["role"] == "user" and isinstance(m["content"], str)), "")
        if _TEST_W.search(prev):
            out[0].topics = topics_in(prev)
    return out[:MAX_PER_TURN]


# ------------------------------------------------------------------ deciding the spec
def spec_of(tid: int) -> dict:
    return db.kv_get(f"practice_spec_{tid}", {}) or {}


def _practice_tests(limit: int = 60) -> list[dict]:
    rows = db.q("SELECT id,status,score,max,cancelled,created_at FROM tests WHERE kind='practice' ORDER BY id DESC LIMIT ?", (limit,))
    return [{**r, "spec": spec_of(r["id"])} for r in rows]


def _base(ref: int | str | None, convo: int | None) -> dict | None:
    if ref is None:
        return None
    if isinstance(ref, int):
        t = db.q1("SELECT id,kind,status,score,max,cancelled FROM tests WHERE id=?", (ref,))
        return {**t, "spec": spec_of(ref) if t["kind"] == "practice" else {}} if t else None
    tests = _practice_tests()
    mine = [t for t in tests if convo and t["spec"].get("convo") == convo]
    if mine:
        return mine[-1] if ref == "first" else mine[0]
    # not made in this conversation: the most recent one from the last 12 hours
    cut = (now() - timedelta(hours=12)).isoformat(timespec="seconds")
    recent = [t for t in tests if (t["created_at"] or "") >= cut]
    return recent[0] if recent else None


def _overlap(a: list[str], b: list[str]) -> bool:
    return not a or not b or bool(set(a) & set(b))


def _auto_level(topics: list[str]) -> tuple[str, str]:
    """Level from the last finished practice tests on these topics: ≥80% → one up, <50% → one down."""
    done = [t for t in _practice_tests() if t["status"] == "submitted" and not t["cancelled"] and t["max"]
            and _overlap(topics, t["spec"].get("topic_list") or [])][:3]
    if not done:
        return "medium", "no finished practice on these topics yet, so at your current level"
    pct = round(100 * sum(t["score"] for t in done) / sum(t["max"] for t in done))
    last = done[0]["spec"].get("level") or "medium"
    i = LEVELS.index(last) + (1 if pct >= 80 else -1 if pct < 50 else 0)
    level = LEVELS[max(0, min(2, i))]
    n = len(done)
    return level, f"{pct}% on the last {n} practice test{'s' if n > 1 else ''} at {last}"


def resolve(it: Intent, convo: int | None) -> dict:
    base = _base(it.ref, convo)
    bspec = base["spec"] if base else {}
    topics = it.topics or bspec.get("topic_list") or []
    count = max(COUNT_MIN, min(COUNT_MAX, it.count or bspec.get("count") or COUNT_DEFAULT))
    beyond = False
    if it.level:
        level, why = it.level, "you asked for it"
    elif it.shift:
        start = bspec.get("level") or (_auto_level(topics)[0] if not base else "medium")
        i = LEVELS.index(start) + it.shift
        beyond = i > 2 and base is not None
        level = LEVELS[max(0, min(2, i))]
        why = (f"{'harder' if it.shift > 0 else 'easier'} than #{base['id']} ({start})" if base
               else f"{'harder' if it.shift > 0 else 'easier'} than usual")
    else:
        level, why = _auto_level(topics)
    return {"topics": it.label or " + ".join(topics), "topic_list": topics, "count": count, "asked": it.count,
            "level": level, "level_why": why, "beyond": beyond, "follow_of": base["id"] if base else None, "convo": convo}


def key(spec: dict, copy: int = 0) -> tuple:
    """Same request in one chat turn → same test (the model calling the tool after the app did gets the same one)."""
    return (tuple(sorted(spec["topic_list"])) or spec["topics"].lower(), spec["count"], spec["level"], spec["follow_of"], copy)


def minutes(spec: dict) -> int:
    return max(10, spec["count"] * MIN_PER_Q.get(spec.get("level") or "medium", 3))


def count_note(spec: dict) -> str:
    a = spec.get("asked")
    if a and a > COUNT_MAX:
        return f"you asked for {a}; the limit is {COUNT_MAX}"
    if a and a < COUNT_MIN:
        return f"you asked for {a}; the minimum is {COUNT_MIN}"
    return ""


# ------------------------------------------------------------------ what the generator is told
def _norm(s: str) -> str:
    return re.sub(r"[^0-9a-z+\-*/=^<>]", "", (s or "").lower())


def _keys(q: dict) -> set[tuple[str, str]]:
    k = {("q", _norm((q.get("prompt") or "") + (q.get("math") or "") + (q.get("code") or "")))}
    if len(_norm(q.get("math") or "")) >= 5:
        k.add(("m", _norm(q["math"])))
    if len(_norm(q.get("code") or "")) >= 20:
        k.add(("c", _norm(q["code"])))
    return k


def _earlier(spec: dict, tid: int) -> list[dict]:
    """The follow-up's base test plus the last few practice tests on the same topics (newest first)."""
    seen, out = set(), []
    ids = ([spec["follow_of"]] if spec.get("follow_of") else []) + [
        t["id"] for t in _practice_tests(20) if t["id"] != tid and t["status"] != "generating"
        and _overlap(spec.get("topic_list") or [], t["spec"].get("topic_list") or [])][:4]
    for i in ids:
        if i in seen:
            continue
        seen.add(i)
        t = db.decode(db.q1("SELECT id,status,questions,results,score,max,cancelled FROM tests WHERE id=?", (i,)))
        if t and t["questions"]:
            out.append(t)
    return out


def brief(spec: dict, tid: int) -> tuple[str, list[str]]:
    """The level and earlier-tests part of the prompt, plus lines for the live log."""
    level = spec.get("level") or "medium"
    parts = [f"Level: {level.upper()}: {LEVEL_TEXT[level]}"]
    log = []
    earlier = _earlier(spec, tid)
    base = earlier[0] if earlier and earlier[0]["id"] == spec.get("follow_of") else None
    if base:
        res = {r["id"]: r for r in base.get("results") or []}
        lines = []
        for q in base["questions"]:
            r = res.get(q["id"])
            got = ("" if not r else " · user: correct" if r["correct"] else
                   f" · user: wrong (gave {r['given']!r})" if r["given"] else " · user: unanswered")
            body = " ".join(x for x in (q.get("prompt", ""), q.get("math", ""), (q.get("code") or "").replace("\n", " ")[:160]) if x)
            lines.append(f"- [{q.get('topic', '')}, {q['type']}] {body[:320]} → {q.get('answer', '')}{got}")
        done = base["status"] == "submitted" and not base["cancelled"]
        head = f"This is a follow-up to practice test #{base['id']}" + (f" (score {base['score']:g}/{base['max']:g})" if done else "")
        wrong = sorted({r["topic"] for r in res.values() if not r["correct"] and r.get("topic")}) if done else []
        parts.append(head + ". Its questions:\n" + "\n".join(lines))
        if spec.get("beyond") or (spec.get("level_why", "").startswith("harder")):
            parts.append(f"Make every question clearly harder than test #{base['id']}'s: more steps, less familiar setups, no question that "
                         "is the same template with new numbers.")
        if wrong:
            parts.append("Give extra weight to what the user got wrong there: " + ", ".join(wrong) + ".")
        log.append(f"Read test #{base['id']}" + (f": {base['score']:g}/{base['max']:g} correct" if done else "")
                   + (f", more weight on {', '.join(wrong)}" if wrong else ""))
    others = [t for t in earlier if t is not base]
    if others:
        prompts = [f"- {q.get('prompt', '')} {q.get('math', '')}".strip()[:200] for t in others for q in t["questions"]][:40]
        parts.append("Questions from earlier practice tests on these topics (do not repeat them):\n" + "\n".join(prompts))
    if earlier:
        parts.append("Never repeat an earlier question, formula or program, and don't reuse the same template with new numbers.")
        log.append(f"Will avoid the {sum(len(t['questions']) for t in earlier)} questions of earlier test"
                   f"{'s' if len(earlier) > 1 else ''} " + ", ".join(f"#{t['id']}" for t in earlier))
    return "\n\n".join(parts), log


def drop_repeats(qs: list[dict], spec: dict, tid: int, log) -> list[dict]:
    """Remove questions that are the same as one from an earlier test (or twice in this one), whatever the model did."""
    seen: set = set()
    for t in _earlier(spec, tid):
        for q in t["questions"]:
            seen |= _keys(q)
    out, rep = [], []
    for n, q in enumerate(qs, 1):
        k = _keys(q)
        if k & seen:
            rep.append((n, q))
            continue
        seen |= k
        out.append(q)
    keep = max(0, min(len(qs), COUNT_MIN) - len(out))   # never fewer than 3 questions: then the oldest repeats stay
    for n, q in rep[keep:]:
        log(f"Question {n}: dropped, it repeats an earlier question", "warn")
    if keep:
        log(f"Kept {keep} repeated question{'s' if keep > 1 else ''} so the test has at least {COUNT_MIN}", "warn")
        out = [q for q in qs if any(q is x for x in out) or any(q is x for _, x in rep[:keep])]
    for n, q in enumerate(out, 1):
        q["id"] = f"q{n}"
    return out
