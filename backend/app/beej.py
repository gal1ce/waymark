"""Beej's Guide to C, read inside the app instead of on beej.us.

A chapter page is fetched once, kept under DATA_DIR/beej, and turned into a list of blocks the frontend draws
itself: prose as cleaned HTML (a small tag and attribute allowlist, nothing executable), code as plain text so it
gets the app's own code block. Links to other chapters stay in the reader; the guide's footnotes, which all live
on one page at the end of the book, come back with the chapter that cites them: notes that only repeat the URL of
the link right before them are dropped, the rest are listed under the chapter.

The guide is CC BY-NC-ND 3.0 (Brian “Beej Jorgensen” Hall). The text is shown unchanged, with the credit and a
link to the original."""
from __future__ import annotations

import html
import json
import re
import threading
import urllib.request
from html.parser import HTMLParser

from .config import DATA_DIR

BASE = "https://beej.us/guide/bgc/html/split/"
NOTES_PAGE = "function-specifiers-alignment-specifiersoperators.html"
CACHE = DATA_DIR / "beej"
PAGE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.html$")
_lock = threading.Lock()


class NotFound(Exception):
    pass


def _fetch(page: str) -> str:
    if not PAGE_RE.match(page):
        raise NotFound(page)
    f = CACHE / page
    if f.is_file():
        return f.read_text(encoding="utf-8")
    req = urllib.request.Request(BASE + page, headers={"User-Agent": "Mozilla/5.0 (study app reader)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(page) from e
        raise
    with _lock:
        CACHE.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(f)
    return text


def _body(doc: str) -> str:
    m = re.search(r"<body[^>]*>(.*)</body>", doc, re.S)
    body = m.group(1) if m else doc
    # the Prev | Contents | Next bars at the top and bottom; the reader draws its own
    body = re.sub(r'^\s*<div style="text-align:center">.*?</div>\s*<hr\s*/?>', "", body, count=1, flags=re.S)
    body = re.sub(r'<hr\s*/?>\s*<div style="text-align:center">.*?</div>\s*$', "", body, count=1, flags=re.S)
    # the book's footnotes all sit at the end of its last page; chapters bring their own (see chapter())
    return re.sub(r'<section[^>]*class="footnotes[^"]*".*?</section>', "", body, flags=re.S)


_notes: dict[str, str] | None = None


def _footnotes() -> dict[str, str]:
    """fnN -> the note's inner HTML (cleaned, without the back link)."""
    global _notes
    if _notes is None:
        doc = _fetch(NOTES_PAGE)
        out = {}
        for m in re.finditer(r'<li id="(fn\d+)">(.*?)</li>', doc, re.S):
            inner = re.sub(r'<a [^>]*class="footnote-back"[^>]*>.*?</a>', "", m.group(2), flags=re.S).strip()
            inner = re.sub(r"^<p>(.*)</p>$", r"\1", inner, flags=re.S).strip()
            out[m.group(1)] = inner
        _notes = out
    return _notes


ALLOWED = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "em", "strong", "b", "i", "code", "span", "div", "ul", "ol", "li",
           "blockquote", "table", "thead", "tbody", "tr", "th", "td", "sup", "sub", "br", "hr", "dl", "dt", "dd",
           "caption", "kbd", "var", "figure", "figcaption", "colgroup", "col", "img"}
VOID = {"br", "hr", "col", "img"}
SKIP = {"script", "style", "iframe", "object", "embed", "form", "input", "button", "svg", "math", "noscript", "template"}
SECTION_TAGS = {"h2", "h3"}


def _link(href: str, page: str) -> tuple[str, bool]:
    """(href for the reader, opens outside). Chapter links become #page/anchor routes the reader resolves."""
    if re.match(r"^https?://", href):
        return href, True
    m = re.match(r"^([a-z0-9][a-z0-9-]*\.html)?(?:#([\w.:-]+))?$", href)
    if not m:
        return "", False
    target, anchor = m.group(1) or page, m.group(2) or ""
    return f"beej:{target[:-5]}" + (f"#{anchor}" if anchor else ""), False


class _Clean(HTMLParser):
    """Rebuilds the chapter body from an allowlist and splits it into prose and code blocks."""

    def __init__(self, page: str, notes: dict[str, str]):
        super().__init__(convert_charrefs=True)
        self.page, self.notes = page, notes
        self.blocks: list[dict] = []
        self.sections: list[dict] = []
        self.cited: list[tuple[str, str]] = []  # (fn id, label) kept, in reading order
        self.buf: list[str] = []
        self.stack: list[str] = []  # open allowed tags, to close them in order
        self.skip = 0
        self.code: list[str] | None = None  # inside <pre>: plain text only
        self.code_lang = ""
        self.drop_a = 0  # inside an <a> we leave out (line-number anchors, footnote refs)
        self.last_href = ""  # the most recent outside link, to tell link-only footnotes apart
        self.heading: dict | None = None
        self.in_num = False  # inside a heading's section number span

    # -- helpers
    def _flush(self):
        text = "".join(self.buf).strip()
        if text:
            self.blocks.append({"type": "html", "html": text})
        self.buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.skip or tag in SKIP:
            if tag in SKIP and tag not in VOID:
                self.skip += 1
            return
        if self.code is not None:
            if tag == "a":
                self.drop_a += 1
            return
        if tag == "div" and "sourceCode" in (a.get("class") or ""):
            return  # wrapper of a code block; the <pre> inside carries the language
        if tag == "pre":
            self._flush()
            cls = (a.get("class") or "").split()
            self.code_lang = "c" if "c" in cls or "cpp" in cls else ("sh" if {"zsh", "bash", "sh", "shell"} & set(cls) else "")
            self.code = []
            return
        if tag == "a":
            if "footnote-ref" in (a.get("class") or ""):
                fid = (a.get("href") or "").partition("#")[2]
                note = self.notes.get(fid, "")
                plain = re.sub(r"<[^>]+>", "", note).strip()
                if not note or (re.match(r"^https?://\S+$", plain) and plain.rstrip("/") == self.last_href.rstrip("/")):
                    self.drop_a += 1
                    return
                n = str(len(self.cited) + 1)
                self.cited.append((fid, n))
                self.buf.append(f'<sup class="bj-fn"><a href="#bj-{fid}" id="bj-ref-{fid}" data-fn="{fid}">{n}</a></sup>')
                self.drop_a += 1  # the original <sup>N</sup> inside is replaced by ours
                return
            href, outside = _link(a.get("href") or "", self.page)
            if not href:
                self.buf.append("<a>")
            elif outside:
                self.last_href = href
                self.buf.append(f'<a href="{html.escape(href)}" target="_blank" rel="noreferrer">')
            else:
                self.buf.append(f'<a href="{html.escape(href)}">')
            self.stack.append("a")
            return
        if self.drop_a:
            return
        if tag not in ALLOWED:
            return
        if tag == "img":
            src = a.get("src") or ""
            if re.match(r"^[\w./-]+\.(png|jpe?g|gif|svg)$", src) and ".." not in src:
                alt = html.escape(a.get("alt") or "")
                self.buf.append(f'<img src="/api/beej/asset/{html.escape(src)}" alt="{alt}" loading="lazy">')
            return
        keep = []
        if "id" in a and re.match(r"^[\w.:-]+$", a["id"] or ""):
            keep.append(f'id="{a["id"]}"')
        if tag in SECTION_TAGS and a.get("data-number"):
            self._flush()
            self.heading = {"id": a.get("id") or "", "num": a["data-number"], "title": "", "level": int(tag[1])}
        if tag == "span" and "header-section-number" in (a.get("class") or ""):
            keep.append('class="bj-num"')
            self.in_num = True
        if tag in ("td", "th") and a.get("style") and re.match(r"^text-align: ?(left|right|center);?$", a["style"]):
            keep.append(f'style="{a["style"]}"')
        self.buf.append(f"<{tag}{' ' if keep else ''}{' '.join(keep)}>")
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.skip:
            if tag in SKIP:
                self.skip -= 1
            return
        if self.code is not None:
            if tag == "a" and self.drop_a:
                self.drop_a -= 1
            elif tag == "pre":
                self.blocks.append({"type": "code", "lang": self.code_lang, "code": "".join(self.code).rstrip("\n")})
                self.code = None
            return
        if tag == "a" and self.drop_a:
            self.drop_a -= 1
            return
        if self.drop_a or tag not in ALLOWED or tag in VOID:
            return
        if tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.buf.append(f"</{t}>")
                if t == tag:
                    break
        if tag == "span":
            self.in_num = False
        if tag in SECTION_TAGS and self.heading:
            self.heading["title"] = re.sub(r"\s+", " ", self.heading["title"]).strip()
            self.sections.append(self.heading)
            self.heading = None

    def handle_data(self, data):
        if self.skip or self.drop_a and self.code is None:
            return
        if self.code is not None:
            if not self.drop_a:
                self.code.append(data)
            return
        if self.heading is not None and not self.in_num:
            self.heading["title"] += data
        self.buf.append(html.escape(data, quote=False))

    def close(self):
        super().close()
        while self.stack:
            self.buf.append(f"</{self.stack.pop()}>")
        self._flush()


def chapter(page: str) -> dict:
    """One page of the guide, ready for the reader. page is e.g. 'hello-world' (no .html)."""
    name = page + ".html"
    doc = _fetch(name)
    try:
        notes = _footnotes()
    except Exception:  # noqa: BLE001 - the chapter still reads fine without its notes
        notes = {}
    body = _body(doc)
    p = _Clean(name, notes)
    p.feed(body)
    p.close()
    title_m = re.search(r'<h1[^>]*>(?:<span class="header-section-number">([^<]*)</span>)?\s*(.*?)</h1>', body, re.S)
    num, title = (title_m.group(1) or "", re.sub(r"<[^>]+>", "", html.unescape(title_m.group(2))).strip()) if title_m else ("", page)
    nav = {rel: href[:-5] for href, rel in re.findall(r'<a href="([a-z0-9-]+\.html)" rel="(prev|next)"', doc)}
    return {
        "page": page, "num": num, "title": title, "blocks": p.blocks, "sections": p.sections,
        "notes": [{"id": fid, "n": n, "html": _clean_fragment(notes[fid], name)} for fid, n in p.cited],
        "prev": nav.get("prev"), "next": nav.get("next"), "source": BASE + name,
    }


def _clean_fragment(frag: str, page: str) -> str:
    p = _Clean(page, {})
    p.feed(frag)
    p.close()
    return "".join(b.get("html", "") for b in p.blocks)


def contents() -> list[dict]:
    """The guide's chapter list from its index page: [{page, num, title}]."""
    doc = _fetch("index.html")
    out = []
    for href, num, title in re.findall(
            r'<li><a href="([a-z0-9-]+)\.html#[^"]*"[^>]*><span class="toc-section-number">(\d+)</span>\s*(.*?)</a>', doc, re.S):
        out.append({"page": href, "num": num, "title": re.sub(r"<[^>]+>", "", html.unescape(title)).strip()})
    return out


def asset(name: str) -> bytes:
    if not re.match(r"^[\w-]+(/[\w-]+)*\.(png|jpe?g|gif|svg)$", name):
        raise NotFound(name)
    f = CACHE / "assets" / name
    if not f.is_file():
        req = urllib.request.Request(BASE + name, headers={"User-Agent": "Mozilla/5.0 (study app reader)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return f.read_bytes()


# ------------------------------------------------------------------ the short version
# Beej writes to entertain; a study evening needs the substance. The coach condenses each section (h2) to a few
# points, the code blocks stay as Beej wrote them, and the full text of any section is one click away. Written
# once per chapter and language, kept next to the cached page.

def groups(blocks: list[dict]) -> list[dict]:
    """The chapter's blocks split at each h2: [{id, blocks}]; text before the first h2 is 'intro'."""
    out: list[dict] = [{"id": "intro", "blocks": []}]
    for b in blocks:
        m = re.match(r'<h2 id="([^"]+)"', b.get("html", "")) if b["type"] == "html" else None
        if m:
            out.append({"id": m.group(1), "blocks": []})
        out[-1]["blocks"].append(b)
    return [g for g in out if g["id"] != "intro" or any(
        b["type"] == "code" or re.sub(r"<h1.*?</h1>|<[^>]+>|\s", "", b.get("html", ""), flags=re.S) for b in g["blocks"])]


def _plain(b: dict) -> str:
    if b["type"] == "code":
        return f"```{b['lang']}\n{b['code']}\n```"
    t = re.sub(r"<h1.*?</h1>", "", b["html"], flags=re.S)
    t = re.sub(r"<code>(.*?)</code>", r"`\1`", t, flags=re.S)
    t = re.sub(r"<(?:li)[^>]*>", "- ", t)
    t = re.sub(r"<h[23][^>]*>", "## ", t)
    return html.unescape(re.sub(r"<[^>]+>", "", t)).strip()


SHORT_SYSTEM = """You condense one chapter of Beej's Guide to C for a student who wants the substance without the jokes.
For every section you are given, write the few points a reader must take away: the rules, the syntax, what the code
does and why, the gotchas. Each point is one short sentence (a second only when it carries a needed fact). Use
`backticks` for code, keywords, flags and file names. Drop jokes, anecdotes, asides and history unless a fact depends
on them. Add nothing that is not in the text. A section that is only housekeeping (contact, licence, mirrors,
translators, dedication) gets one point saying what it is and that it can be skipped. Most sections need 2-5 points;
a long dense one may need up to 8. Write in {lang}; keep C code, keywords and identifiers as they are."""

SHORT_SCHEMA = {"type": "object", "properties": {"points": {"type": "array", "items": {"type": "string"}}}}


async def short(page: str, lang: str) -> dict:
    """{sections: [{id, points}], missing: [id]}. One small request per section (a large one is what a busy free
    model turns away first), three at a time; finished sections are kept, so a retry only asks for the rest."""
    import asyncio

    from . import llm  # the reader works without the AI; only this needs it
    lang = "tr" if lang == "tr" else "en"
    f = CACHE / "short" / f"{page}.{lang}.json"
    done: dict[str, list[str]] = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}
    ch = chapter(page)
    gs = groups(ch["blocks"])
    system = SHORT_SYSTEM.format(lang={"en": "English", "tr": "Turkish"}[lang])
    gate = asyncio.Semaphore(3)
    errors: list[Exception] = []

    async def one(g: dict):
        async with gate:
            prompt = (f"Chapter {ch['num']}: {ch['title']}. One section of it:\n\n"
                      + "\n\n".join(_plain(b) for b in g["blocks"]))
            try:
                out = await llm.structured(system, prompt, llm.strict(json.loads(json.dumps(SHORT_SCHEMA))),
                                           effort="low", max_tokens=3000)
            except llm.NoKey:
                raise
            except Exception as e:  # noqa: BLE001 - one busy section must not lose the others
                errors.append(e)
                return
            pts = [p.strip() for p in out.get("points", []) if isinstance(p, str) and p.strip()][:10]
            if pts:
                done[g["id"]] = pts

    await asyncio.gather(*(one(g) for g in gs if g["id"] not in done))
    if done:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    elif errors:
        raise RuntimeError(str(errors[0]))
    return {"sections": [{"id": g["id"], "points": done[g["id"]]} for g in gs if g["id"] in done],
            "missing": [g["id"] for g in gs if g["id"] not in done]}
