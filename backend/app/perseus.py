"""Khan Academy exercise items (Perseus format): which ones the app can show, what the browser may see,
and grading.

An item is markdown with $TeX$ and widget placeholders ("[[☃ numeric-input 1]]"). The answers live in
the widget options, so the browser only ever gets a copy with them removed; checking happens here.

Supported widgets: numeric-input, input-number, expression (sympy, the way Khan's KAS compares them),
radio, dropdown, plus the display-only image / definition / explanation. Items with anything else
(graphing, drag and drop...) are left to the Kolibri player.
"""
from __future__ import annotations

import json
import math
import random
import re
from fractions import Fraction

GRADED = {"numeric-input", "input-number", "expression", "radio", "dropdown"}
DISPLAY = {"image", "definition", "explanation"}
SUPPORTED = GRADED | DISPLAY
PLACEHOLDER = re.compile(r"\[\[☃ ([a-z-]+ \d+)\]\]")
LOCAL = "${☣ LOCALPATH}/images/"


# ------------------------------------------------------------------ which items the app can show
def widgets_used(part: dict) -> dict:
    """Widgets a question/hint actually places (unreferenced leftovers in the options are ignored)."""
    names = set(PLACEHOLDER.findall(part.get("content", "")))
    return {k: v for k, v in (part.get("widgets") or {}).items() if k in names}


def supported(item: dict) -> bool:
    q = item.get("question") or {}
    ws = widgets_used(q)
    if not any(w.get("type") in GRADED for w in ws.values()):
        return False
    for w in ws.values():
        t = w.get("type")
        if t not in SUPPORTED:
            return False
        if t == "expression" and not all(_parse_answer(f.get("value", "")) is not None
                                         for f in (w.get("options") or {}).get("answerForms", [])):
            return False
        if t == "numeric-input" and (w.get("options") or {}).get("multipleNumberInput"):
            return False
        if t in DISPLAY:
            # nested content (an explanation's text) must not hide graded widgets of its own
            inner = (w.get("options") or {}).get("widgets") or {}
            if any(x.get("type") not in DISPLAY for x in inner.values()):
                return False
    return True


# ------------------------------------------------------------------ the copy the browser gets
def _img_url(base: str, ref: str) -> tuple[str, bool]:
    """Kolibri's local image reference → our URL. Graphie images are an svg plus a label file."""
    graphie = ref.startswith("web+graphie:")
    name = ref.removeprefix("web+graphie:").removeprefix(LOCAL)
    name = re.sub(r"[^A-Za-z0-9._-]", "", name)
    return (f"{base}/{name}.svg" if graphie else f"{base}/{name}"), graphie


def _rewrite(text: str, base: str, graphie: set) -> str:
    def sub(m: re.Match) -> str:
        url, g = _img_url(base, m.group(2))
        if g:
            graphie.add(url)
        return f"![{m.group(1)}]({url})"
    return re.sub(r"!\[([^\]]*)\]\(((?:web\+graphie:)?\$\{☣ LOCALPATH\}/images/[^)\s]+)\)", sub, text or "")


def _shuffle(n: int, seed: str, keep_last: int | None) -> list[int]:
    order = [i for i in range(n) if i != keep_last]
    random.Random(seed).shuffle(order)
    return order + ([keep_last] if keep_last is not None else [])


def radio_order(w: dict, seed: str) -> list[int]:
    o = w.get("options") or {}
    ch = o.get("choices") or []
    nota = next((i for i, c in enumerate(ch) if c.get("isNoneOfTheAbove")), None)
    return _shuffle(len(ch), seed, nota) if o.get("randomize") else list(range(len(ch)))


def public(part: dict, base: str, seed: str) -> dict:
    """The question or a hint with every answer, correct flag and clue removed."""
    graphie: set[str] = set()
    out_w = {}
    for name, w in widgets_used(part).items():
        t, o = w.get("type"), w.get("options") or {}
        if t == "numeric-input":
            forms = sorted({f for a in o.get("answers", []) if a.get("status") == "correct" for f in (a.get("answerForms") or [])})
            pub = {"size": o.get("size"), "coefficient": bool(o.get("coefficient")), "label": o.get("labelText", ""),
                   "forms": forms if any(a.get("strict") for a in o.get("answers", [])) else []}
        elif t == "input-number":
            pub = {"size": o.get("size"), "answerType": o.get("answerType", "number")}
        elif t == "expression":
            pub = {"functions": o.get("functions") or []}
        elif t == "radio":
            ch = o.get("choices") or []
            pub = {"multiple": bool(o.get("multipleSelect")),
                   "count": sum(1 for c in ch if c.get("correct")) if o.get("countChoices") else None,
                   "choices": [{"i": i, "content": "None of the above" if ch[i].get("isNoneOfTheAbove") and not ch[i].get("content")
                                else _rewrite(ch[i].get("content", ""), base, graphie)} for i in radio_order(w, seed + name)]}
        elif t == "dropdown":
            pub = {"placeholder": o.get("placeholder", ""),
                   "choices": [{"i": i, "content": c.get("content", "")} for i, c in enumerate(o.get("choices") or [])]}
        elif t == "image":
            bg = o.get("backgroundImage") or {}
            url, g = _img_url(base, bg.get("url", "")) if bg.get("url") else ("", False)
            if g:
                graphie.add(url)
            pub = {"url": url, "width": bg.get("width"), "height": bg.get("height"), "alt": o.get("alt", ""),
                   "caption": _rewrite(o.get("caption", ""), base, graphie), "title": o.get("title", "")}
        elif t == "definition":
            pub = {"prompt": o.get("togglePrompt", ""), "text": _rewrite(o.get("definition", ""), base, graphie)}
        elif t == "explanation":
            pub = {"show": o.get("showPrompt", "Explain"), "hide": o.get("hidePrompt", "Hide"),
                   "text": _rewrite(o.get("explanation", ""), base, graphie)}
        else:
            continue
        out_w[name] = {"type": t, **pub}
    return {"content": _rewrite(part.get("content", ""), base, graphie), "widgets": out_w, "graphie": sorted(graphie)}


def graphie_labels(data: bytes) -> dict:
    """images/<hash>-data.json is JSONP: svgData<hash>({"range": ..., "labels": [...]}). Positions become
    percentages of the picture, so the labels sit right at any display size."""
    text = data.decode("utf-8", "replace")
    body = text[text.index("(") + 1: text.rindex(")")]
    d = json.loads(body)
    (x0, x1), (y0, y1) = d.get("range", [[0, 1], [0, 1]])
    out = []
    for lab in d.get("labels", []):
        x, y = lab.get("coordinates", [0, 0])[:2]
        out.append({"left": (x - x0) / ((x1 - x0) or 1) * 100, "top": (y1 - y) / ((y1 - y0) or 1) * 100,
                    "align": lab.get("alignment", "center"), "math": bool(lab.get("typesetAsMath", True)),
                    "content": lab.get("content", "")})
    return {"labels": out}


# ------------------------------------------------------------------ numbers
_PI = re.compile(r"^(?P<num>[-+]?[\d.]*)\s*(?:\*\s*)?(?:pi|π|\\pi)\s*(?:/\s*(?P<den>\d+))?$")


def parse_number(s: str) -> tuple[float | None, str, tuple[int, int] | None]:
    """Value, form (integer/decimal/proper/improper/mixed/percent/pi) and the fraction as typed (n, d), if any."""
    s = (s or "").strip().replace("−", "-").replace("–", "-").replace(" ", " ")
    s = re.sub(r"^\$|\$$", "", s).strip()
    if not s:
        return None, "", None
    if re.fullmatch(r"[-+]?\d{1,3}(,\d{3})+(\.\d+)?", s):
        s = s.replace(",", "")
    if s.endswith("%"):
        v, _, _ = parse_number(s[:-1])
        return (None if v is None else v / 100), "percent", None
    m = _PI.match(s)
    if m:
        num = m.group("num")
        k = 1.0 if num in ("", "+") else -1.0 if num == "-" else _float(num)
        if k is None:
            return None, "", None
        return k * math.pi / int(m.group("den") or 1), "pi", None
    m = re.fullmatch(r"([-+]?)(\d+)\s+(\d+)\s*/\s*(\d+)", s)
    if m:
        whole, n, d = int(m.group(2)), int(m.group(3)), int(m.group(4))
        if d == 0:
            return None, "", None
        f = Fraction(whole * d + n, d) * (-1 if m.group(1) == "-" else 1)
        return float(f), "mixed", (n, d)
    m = re.fullmatch(r"\(?([-+]?\d+)\s*/\s*([-+]?\d+)\)?", s)
    if m:
        n, d = int(m.group(1)), int(m.group(2))
        if d == 0:
            return None, "", None
        return n / d, ("proper" if abs(n) < abs(d) else "improper"), (n, d)
    v = _float(s)
    if v is None:
        return None, "", None
    return v, ("integer" if re.fullmatch(r"[-+]?\d+", s) else "decimal"), None


def _float(s: str) -> float | None:
    if not re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?", s):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _close(a: float, b: float, max_error: float | None) -> bool:
    return abs(a - b) <= max(max_error or 0, 1e-9 * max(1.0, abs(b)))


def _unsimplified(typed: tuple[int, int] | None) -> bool:
    return bool(typed) and math.gcd(*typed) > 1


def _grade_numeric(o: dict, given: str) -> tuple[bool, str]:
    s = (given or "").strip()
    if o.get("coefficient") and s in ("", "+", "-"):
        s = s + "1"
    v, form, frac = parse_number(s)
    if v is None:
        return False, "Enter a number (fractions like 3/4 work)." if s else ""
    for a in o.get("answers", []):
        if a.get("value") is None or not _close(v, float(a["value"]), a.get("maxError")):
            continue
        if a.get("status") != "correct":
            return False, a.get("message", "") or ""
        if a.get("simplify") in ("required", "enforced") and _unsimplified(frac):
            return False, "Right value, but simplify the fraction."
        forms = a.get("answerForms") or []
        if a.get("strict") and forms and form not in forms and not (form == "integer" and float(v).is_integer()):
            return False, "Right value, but write it as " + " or ".join(forms) + "."
        return True, a.get("message", "") or ""
    return False, ""


def _grade_input_number(o: dict, given: str) -> tuple[bool, str]:
    v, form, frac = parse_number(given)
    if v is None:
        return False, ""
    want = float(o.get("value", 0))
    err = o.get("maxError") if o.get("inexact") else None
    candidates = [v]
    if o.get("answerType") == "percent" and form != "percent":
        candidates += [v / 100]
    if form == "percent":
        candidates += [v * 100]
    if not any(_close(c, want, err) for c in candidates):
        return False, ""
    if o.get("simplify") in ("required", "enforced") and _unsimplified(frac):
        return False, "Right value, but simplify the fraction."
    if o.get("answerType") == "integer" and form not in ("integer",) and not float(v).is_integer():
        return False, ""
    return True, ""


# ------------------------------------------------------------------ expressions
_SAFE = re.compile(r"^[0-9A-Za-z+\-*/^().,<>=!_|\s]*$")
_NAMES = {"pi", "theta", "sqrt", "ln", "log", "sin", "cos", "tan", "abs", "Abs", "oo"}


def latex_to_plain(s: str) -> str:
    s = (s or "").replace("−", "-").replace("·", "*").replace("×", "*").replace("÷", "/")
    s = s.replace("≤", "<=").replace("≥", ">=").replace("≠", "!=").replace("π", "pi").replace("θ", "theta")
    s = re.sub(r"\\(left|right|displaystyle|,|!|;|:|\s)", lambda m: " " if m.group(1) in (",", ";", ":", " ") else "", s)
    s = re.sub(r"\\text\{([^{}]*)\}", r"\1", s)
    for cmd, rep in (("dfrac", "frac"), ("tfrac", "frac"), ("leqslant", "le"), ("geqslant", "ge"), ("leq", "le"),
                     ("geq", "ge"), ("neq", "ne")):
        s = s.replace("\\" + cmd, "\\" + rep)
    s = _frac_sqrt(s)
    for cmd, rep in (("cdot", "*"), ("times", "*"), ("ast", "*"), ("div", "/"), ("le", "<="), ("ge", ">="),
                     ("lt", "<"), ("gt", ">"), ("ne", "!="), ("pi", " pi "), ("theta", " theta "), ("infty", " oo "),
                     ("sin", " sin"), ("cos", " cos"), ("tan", " tan"), ("ln", " ln"), ("log", " log"), ("%", "/100")):
        s = re.sub(r"\\" + re.escape(cmd) + r"(?![A-Za-z])", rep, s)
    s = re.sub(r"_\{([^{}]*)\}", r"_\1", s)
    s = s.replace("{", "(").replace("}", ")")
    s = re.sub(r"\|([^|]+)\|", r"Abs(\1)", s)
    return s.strip()


def _group(s: str, i: int) -> tuple[str, int]:
    """The {...} group starting at s[i] (or a single character), and the index after it."""
    while i < len(s) and s[i] == " ":
        i += 1
    if i >= len(s):
        return "", i
    if s[i] != "{":
        return s[i], i + 1
    depth = 0
    for j in range(i, len(s)):
        depth += {"{": 1, "}": -1}.get(s[j], 0)
        if depth == 0:
            return s[i + 1:j], j + 1
    return s[i + 1:], len(s)


def _frac_sqrt(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        if s.startswith("\\frac", i):
            a, j = _group(s, i + 5)
            b, j = _group(s, j)
            out.append(f"(({_frac_sqrt(a)})/({_frac_sqrt(b)}))")
            i = j
        elif s.startswith("\\sqrt", i):
            j = i + 5
            if j < len(s) and s[j] == "[":
                k = s.index("]", j)
                n = s[j + 1:k]
                a, j = _group(s, k + 1)
                out.append(f"(({_frac_sqrt(a)})^(1/({n})))")
            else:
                a, j = _group(s, j)
                out.append(f"sqrt({_frac_sqrt(a)})")
            i = j
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


_REL = re.compile(r"(<=|>=|!=|=|<|>)")


_GLOBALS: dict | None = None


def _globals() -> dict:
    """sympy's names for the transformed code (Mul, Add, Integer...), without Python builtins."""
    global _GLOBALS
    if _GLOBALS is None:
        import sympy as sp
        _GLOBALS = {k: v for k, v in vars(sp).items() if not k.startswith("_")} | {"__builtins__": {}}
    return _GLOBALS


def _parse_side(s: str, functions: tuple[str, ...] = ()):
    import sympy as sp
    from sympy.parsing.sympy_parser import (convert_xor, function_exponentiation, implicit_application,
                                            implicit_multiplication, parse_expr, split_symbols_custom,
                                            standard_transformations)
    if not s.strip() or not _SAFE.match(s) or "__" in s or re.search(r"[A-Za-z_]\.|\.[A-Za-z_]", s) or len(s) > 300:
        return None

    def splittable(name: str) -> bool:
        return name not in _NAMES and name not in functions and not re.search(r"[\d_]", name)

    local = {c: sp.Symbol(c) for c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"}
    for f in functions:
        local[f] = sp.Function(f)
    local.update({"pi": sp.pi, "theta": sp.Symbol("theta"), "sqrt": sp.sqrt, "ln": sp.log, "log": sp.log,
                  "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "Abs": sp.Abs, "abs": sp.Abs, "oo": sp.oo})
    tr = standard_transformations + (split_symbols_custom(splittable), implicit_multiplication, implicit_application,
                                     function_exponentiation, convert_xor)
    try:
        return parse_expr(s, local_dict=local, global_dict=_globals(), transformations=tr, evaluate=False)
    except Exception:
        return None


def _parse(s: str, functions: tuple[str, ...] = ()):
    """'3S+2M<=25' → ('<=', lhs, rhs); a plain expression → (None, expr, None). None if it can't be read."""
    plain = latex_to_plain(s)
    parts = _REL.split(plain)
    if len(parts) == 1:
        e = _parse_side(plain, functions)
        return None if e is None else (None, e, None)
    if len(parts) != 3:
        return None
    lhs, rel, rhs = parts
    a, b = _parse_side(lhs, functions), _parse_side(rhs, functions)
    if a is None or b is None:
        return None
    if rel in (">", ">="):
        a, b, rel = b, a, "<" if rel == ">" else "<="
    return rel, a, b


def _parse_answer(s: str):
    return _parse(s, ("f", "g", "h"))


def _samples(syms, n: int = 10, seed: int = 7):
    rnd = random.Random(seed)
    for _ in range(n):
        yield {x: rnd.choice([-1, 1]) * rnd.uniform(0.3, 4.7) for x in syms}


def _num(e, pt) -> complex | None:
    try:
        v = complex(e.evalf(subs=pt, n=15))
    except Exception:
        return None
    return v if math.isfinite(v.real) and math.isfinite(v.imag) else None


def _concrete(e, functions: tuple[str, ...]):
    """Unknown functions like f(x) get a fixed meaning so both sides can be evaluated."""
    import sympy as sp
    t = sp.Symbol("_t")
    for k, f in enumerate(functions):
        e = e.replace(sp.Function(f), sp.Lambda(t, t ** 2 + (k + 2) * t + 1))
    return e


def equivalent(given: str, want: str, functions: tuple[str, ...] = (), *, form: bool = False,
               simplify: bool = False) -> bool:
    g, w = _parse(given, functions), _parse(want, functions)
    if g is None or w is None:
        return False
    if (g[0] is None) != (w[0] is None):
        return False
    if g[0] is not None and (g[0] != w[0] and not {g[0], w[0]} == {"="}):
        return False
    if w[0] is None:
        dg, dw = _concrete(g[1], functions), _concrete(w[1], functions)
        ok = _same_values(dg, dw)
    else:
        dg = _concrete(g[1] - g[2], functions)
        dw = _concrete(w[1] - w[2], functions)
        ok = _proportional(dg, dw, positive=w[0] != "=")
    if not ok:
        return False
    if form and not _same_shape(g, w):
        return False
    if simplify and _ops(g) > _ops(w):
        return False
    return True


def _same_values(a, b) -> bool:
    syms = sorted(a.free_symbols | b.free_symbols, key=str)
    good = 0
    for pt in _samples(syms):
        x, y = _num(a, pt), _num(b, pt)
        if x is None or y is None:
            continue
        if abs(x - y) > 1e-7 * max(1.0, abs(y)):
            return False
        good += 1
    return good >= 3


def _proportional(a, b, positive: bool) -> bool:
    syms = sorted(a.free_symbols | b.free_symbols, key=str)
    ratio = None
    good = 0
    for pt in _samples(syms):
        x, y = _num(a, pt), _num(b, pt)
        if x is None or y is None:
            continue
        if abs(y) < 1e-12:
            if abs(x) > 1e-9:
                return False
            continue
        r = x / y
        if ratio is None:
            ratio = r
        elif abs(r - ratio) > 1e-7 * max(1.0, abs(ratio)):
            return False
        good += 1
    if ratio is None or good < 3 or abs(ratio) < 1e-12:
        return False
    return ratio.real > 0 if positive else True


def _shape(e) -> tuple:
    return (type(e).__name__, len(e.args), tuple(sorted(type(a).__name__ for a in e.args)))


def _same_shape(g, w) -> bool:
    if g[0] is None:
        return _shape(g[1]) == _shape(w[1])
    return {_shape(g[1]), _shape(g[2])} == {_shape(w[1]), _shape(w[2])}


def _ops(p) -> int:
    from sympy import count_ops
    return sum(count_ops(x, visual=False) for x in p[1:] if x is not None)


def _grade_expression(o: dict, given: str) -> tuple[bool, str]:
    if not (given or "").strip():
        return False, ""
    fns = tuple(o.get("functions") or ())
    forms = o.get("answerForms") or []
    for f in sorted(forms, key=lambda f: f.get("considered") != "correct"):
        if equivalent(given, f.get("value", ""), fns, form=bool(f.get("form")), simplify=bool(f.get("simplify"))):
            if f.get("considered") == "correct":
                return True, ""
            return False, ""
    if _parse(given, fns) is None:
        return False, "That couldn't be read as math. Use * for times, ^ for powers, sqrt(...) for roots."
    for f in forms:
        if f.get("considered") == "correct" and equivalent(given, f.get("value", ""), fns):
            return False, "Equivalent, but not in the form the question asks for."
    return False, ""


# ------------------------------------------------------------------ whole item
def grade(item: dict, answers: dict) -> dict:
    """answers: widget name → typed text (inputs), [indices] (radio) or index (dropdown)."""
    per = {}
    for name, w in widgets_used(item["question"]).items():
        t, o = w.get("type"), w.get("options") or {}
        if t not in GRADED or w.get("graded") is False:
            continue
        a = answers.get(name)
        if t == "numeric-input":
            ok, msg = _grade_numeric(o, str(a or ""))
        elif t == "input-number":
            ok, msg = _grade_input_number(o, str(a or ""))
        elif t == "expression":
            ok, msg = _grade_expression(o, str(a or ""))
        elif t == "radio":
            picked = {int(x) for x in (a or []) if str(x).lstrip("-").isdigit()}
            ch = o.get("choices") or []
            right = {i for i, c in enumerate(ch) if c.get("correct")}
            ok = picked == right
            wrong_pick = next((i for i in sorted(picked) if i not in right), None)
            msg = ch[wrong_pick].get("clue", "") if (not ok and wrong_pick is not None) else ""
        else:  # dropdown
            ch = o.get("choices") or []
            try:
                ok = ch[int(a)].get("correct", False) if a is not None and a != "" else False
            except (ValueError, IndexError):
                ok = False
            msg = ""
        per[name] = {"correct": bool(ok), "message": msg}
    return {"correct": bool(per) and all(p["correct"] for p in per.values()), "widgets": per}


def solution(item: dict) -> dict:
    """The right answer for each graded widget, as markdown (shown after a check, a reveal or the test)."""
    out = {}
    for name, w in widgets_used(item["question"]).items():
        t, o = w.get("type"), w.get("options") or {}
        if t == "numeric-input":
            a = next((x for x in o.get("answers", []) if x.get("status") == "correct" and x.get("value") is not None), None)
            out[name] = f"${_fmt_num(a['value'], a.get('answerForms') or [])}$" if a else ""
        elif t == "input-number":
            out[name] = f"${_fmt_num(o.get('value', 0), [])}$"
        elif t == "expression":
            f = next((x for x in o.get("answerForms", []) if x.get("considered") == "correct"), None)
            out[name] = f"${f['value']}$" if f else ""
        elif t == "radio":   # one entry per right choice: a multi-select answer is a list, never one run-on line
            out[name] = [c.get("content", "") or "None of the above" for c in o.get("choices", []) if c.get("correct")]
        elif t == "dropdown":
            out[name] = " · ".join(c.get("content", "") for c in o.get("choices", []) if c.get("correct"))
    return out


def right_choices(item: dict) -> dict[str, list[int]]:
    """For each choice widget, the indices of its right choices (marked on the question once the answer is shown)."""
    return {name: [i for i, c in enumerate((w.get("options") or {}).get("choices") or []) if c.get("correct")]
            for name, w in widgets_used(item["question"]).items() if w.get("type") == "radio"}


def _fmt_num(v, forms: list[str]) -> str:
    v = float(v)
    if v.is_integer():
        return str(int(v))
    f = Fraction(v).limit_denominator(1000)
    if abs(float(f) - v) < 1e-9 and ("proper" in forms or "improper" in forms or "mixed" in forms or f.denominator <= 12):
        sign = "-" if f < 0 else ""
        return f"{sign}\\frac{{{abs(f.numerator)}}}{{{f.denominator}}}"
    return f"{v:g}"


def hints(item: dict) -> list[dict]:
    return item.get("hints") or []
