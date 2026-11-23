"""One request to an OpenAI-compatible chat API (OpenAI, OpenRouter, Groq, Gemini's compatibility endpoint, and local
servers such as Ollama or LM Studio), with one key. Messages, tools and results go in and come out in the Anthropic
shape the rest of the app uses. Retrying, the next key and the next provider are app/llm.py's job; this module only
says what went wrong, as a CallError with a kind the router acts on."""
from __future__ import annotations

import asyncio
import json
import re
import threading
import urllib.error
import urllib.request
import uuid
from types import SimpleNamespace

from . import providers


class CallError(RuntimeError):
    """kind: auth · billing · quota · busy · stalled · offline · request · cut. `message` is for people."""

    def __init__(self, kind: str, message: str, emitted: bool = False):
        self.kind, self.emitted = kind, emitted
        super().__init__(message)


# seconds a stream may stay silent (before the first word or between chunks) before it counts as stalled. Models send
# nothing while they think, so higher effort waits longer; a model on this computer may be slow to start.
STALL_SEC = 40.0


def stall_sec(pid: str, effort: str) -> float:
    return STALL_SEC * {"low": 1.0, "medium": 1.9}.get(effort, 3.0) * (4 if pid == "local" else 1)


# ------------------------------------------------------------------ shapes
def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if b.get("type") == "text")


def to_openai(system, messages: list) -> list:
    out = [{"role": "system", "content": system if isinstance(system, str) else _text(system)}]
    for m in messages:
        role, c = m["role"], m["content"]
        if role == "system":  # mid-conversation status block
            out.append({"role": "user", "content": _text(c)})
        elif role == "user":
            if isinstance(c, str):
                out.append({"role": "user", "content": c})
                continue
            for b in c:
                if b.get("type") == "tool_result":
                    rc = b.get("content")
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"],
                                "content": rc if isinstance(rc, str) else json.dumps(rc, ensure_ascii=False)})
            t = _text(c)
            if t:
                out.append({"role": "user", "content": t})
        else:
            blocks = c if isinstance(c, list) else [{"type": "text", "text": c}]
            msg: dict = {"role": "assistant", "content": _text(blocks) or None}
            calls = []
            for b in blocks:
                if b.get("type") == "tool_use":
                    call = {"id": b["id"], "type": "function",
                            "function": {"name": b["name"], "arguments": json.dumps(b.get("input", {}), ensure_ascii=False)}}
                    if b.get("extra_content"):  # Gemini's thought signature, must be echoed back
                        call["extra_content"] = b["extra_content"]
                    calls.append(call)
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
    return out


def body(pid: str, model: str, system, messages, tools, effort, max_tokens, schema) -> dict:
    b: dict = {"model": model, "messages": to_openai(system, messages)}
    # OpenAI's newer models take only max_completion_tokens; the others take max_tokens
    b["max_completion_tokens" if pid == "openai" else "max_tokens"] = max_tokens
    # reasoning effort: only where every model accepts it (elsewhere a non-reasoning model would refuse the request)
    if pid == "gemini":
        b["reasoning_effort"] = {"low": "low", "medium": "medium"}.get(effort, "high")
    elif pid == "openrouter":
        b["reasoning"] = {"effort": {"low": "low", "medium": "medium"}.get(effort, "high")}
    if tools:
        b["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                                        "parameters": t["input_schema"]}} for t in tools]
    if schema:
        b["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}}
    return b


class _Block(SimpleNamespace):
    def to_dict(self) -> dict:
        return {k: v for k, v in vars(self).items() if v is not None}


def response(text: str, calls: list[dict], fin: str | None) -> SimpleNamespace:
    content = []
    if text:
        content.append(_Block(type="text", text=text))
    for tc in calls:
        args = tc.get("arguments") or "{}"
        try:
            parsed = json.loads(args) if isinstance(args, str) else args
        except json.JSONDecodeError:
            parsed = {}
        content.append(_Block(type="tool_use", id=tc.get("id") or "call_" + uuid.uuid4().hex[:12],
                              name=tc["name"], input=parsed, extra_content=tc.get("extra_content")))
    # Only "stop" is a finished reply. A stream that closed without a finish reason (an overloaded server drops the
    # connection) or one stopped by a filter broke off mid-sentence: never pass the fragment off as a whole answer.
    stop = "tool_use" if calls else "max_tokens" if fin == "length" else "end_turn" if fin in ("stop", "end_turn") else "cut"
    return SimpleNamespace(content=content, stop_reason=stop, finish=fin)


# ------------------------------------------------------------------ errors
# Some providers sit behind Cloudflare, which turns away Python's default client name ("error code: 1010").
USER_AGENT = "waymark-study-app/1.0"


def _headers(key: str) -> dict:
    h = {"Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def classify(code: int, text: str) -> tuple[str, str]:
    """(kind, what to tell the user) for an HTTP error from any provider."""
    low = text.lower()
    try:
        err = json.loads(text)
        err = err[0] if isinstance(err, list) and err else err
        msg = (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict) else err.get("error") or err.get("message")
        msg = str(msg or "").strip()
    except Exception:  # noqa: BLE001 - not JSON
        msg = text.strip()
    msg = msg[:240]
    if "error code: 10" in low and code == 403:   # Cloudflare turned the client away; the key wasn't even looked at
        return "request", f"the provider's firewall turned the request away ({msg}); this is not about the key"
    if code in (401, 403) or ("api key" in low and ("invalid" in low or "not valid" in low or "expired" in low)):
        return "auth", f"the key was refused ({code}{': ' + msg if msg else ''})"
    # a 429 that is really an empty account (OpenAI: insufficient_quota, "no credits remaining") won't pass by waiting
    if code == 429 and any(w in low for w in ("insufficient_quota", "no credits remaining", "insufficient credits",
                                               "insufficient balance", "credit balance is too low")):
        return "billing", f"no credit left on this account (429{': ' + msg if msg else ''})"
    if code == 429:
        return "quota", f"rate limit or free quota used up (429{': ' + msg if msg else ''})"
    if code == 402 or "credit" in low or "insufficient" in low or "billing" in low:
        return "billing", f"no credit left on this key ({code}{': ' + msg if msg else ''})"
    if code >= 500 or code == 529:
        return "busy", f"the service is overloaded or down ({code})"
    if code == 404 and "model" in low:
        return "request", f"the model wasn't found ({msg or code}); pick another in Settings → AI providers"
    return "request", f"the request was refused ({code}{': ' + msg if msg else ''})"


def _http_error(e: urllib.error.HTTPError) -> CallError:
    try:
        text = e.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        text = ""
    kind, msg = classify(e.code, text)
    return CallError(kind, msg)


def _url_error(e: Exception, pid: str, stall: float) -> CallError:
    reason = getattr(e, "reason", e)
    if isinstance(e, TimeoutError) or isinstance(reason, TimeoutError):
        return CallError("stalled", f"no answer for {stall:.0f} s")
    if pid == "local":
        return CallError("offline", f"the local server at {providers.base('local')} isn't answering ({reason})")
    return CallError("offline", f"couldn't connect ({reason})")


# ------------------------------------------------------------------ calls
async def create(pid: str, key: str, model: str, *, system, messages, tools=None, effort="medium", max_tokens=16000,
                 schema=None):
    b = body(pid, model, system, messages, tools, effort, max_tokens, schema)
    url = providers.base(pid) + "/chat/completions"
    timeout = max(120.0, stall_sec(pid, effort) * 3)

    def post() -> dict:
        req = urllib.request.Request(url, data=json.dumps(b).encode(), method="POST", headers=_headers(key))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise _http_error(e) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise _url_error(e, pid, timeout) from None

    data = await asyncio.to_thread(post)
    if data.get("error"):
        err = data["error"]
        kind, msg = classify(int(err.get("code") or 500) if str(err.get("code", "")).isdigit() else 500, json.dumps(data))
        raise CallError(kind, msg)
    ch = (data.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    calls = [{"id": tc.get("id"), "name": tc["function"]["name"], "arguments": tc["function"].get("arguments"),
              "extra_content": tc.get("extra_content")} for tc in msg.get("tool_calls") or []]
    return response(msg.get("content") or "", calls, ch.get("finish_reason"))


_END = object()


async def stream(pid: str, key: str, model: str, *, system, messages, tools=None, effort="medium", max_tokens=16000,
                 schema=None):
    """Yields ("text", delta) and ("tool", name), then ("final", response). Raises CallError; its `emitted` says
    whether words had already gone out (the router then restarts the reply elsewhere)."""
    b = {**body(pid, model, system, messages, tools, effort, max_tokens, schema), "stream": True}
    url = providers.base(pid) + "/chat/completions"
    stall = stall_sec(pid, effort)
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()
    put = lambda x: loop.call_soon_threadsafe(q.put_nowait, x)  # noqa: E731

    def read() -> None:
        req = urllib.request.Request(url, data=json.dumps(b).encode(), method="POST", headers=_headers(key))
        try:
            with urllib.request.urlopen(req, timeout=stall) as r:  # per read: a silent stream ends here
                for raw in r:
                    if stop.is_set():
                        break
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    put(json.loads(data))
        except urllib.error.HTTPError as e:
            put(_http_error(e))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            put(_url_error(e, pid, stall))
        except Exception as e:  # noqa: BLE001 - surfaced to the caller
            put(CallError("busy", f"the stream broke ({e})"))
        finally:
            put(_END)

    fut = loop.run_in_executor(None, read)
    text, calls, fin, emitted = "", {}, None, False
    try:
        while True:
            item = await q.get()
            if item is _END:
                break
            if isinstance(item, CallError):
                item.emitted = emitted
                raise item
            if isinstance(item, list):
                item = item[0] if item and isinstance(item[0], dict) else {}
            if err := item.get("error"):
                code = err.get("code") if isinstance(err, dict) else None
                kind, msg = classify(int(code) if str(code or "").isdigit() else 500, json.dumps(item))
                raise CallError(kind, msg, emitted)
            for ch in item.get("choices") or []:
                d = ch.get("delta") or {}
                fin = ch.get("finish_reason") or fin
                if d.get("content"):
                    text += d["content"]
                    emitted = True
                    yield "text", d["content"]
                for i, tc in enumerate(d.get("tool_calls") or []):
                    k = tc.get("index", i)
                    c = calls.get(k)
                    fn = tc.get("function") or {}
                    if c is None:
                        c = calls[k] = {"id": tc.get("id"), "name": fn.get("name", ""), "arguments": "",
                                        "extra_content": tc.get("extra_content")}
                        if c["name"]:
                            emitted = True
                            yield "tool", c["name"]
                    else:
                        c["id"] = c["id"] or tc.get("id")
                        c["name"] = c["name"] or fn.get("name", "")
                        c["extra_content"] = c["extra_content"] or tc.get("extra_content")
                    args = fn.get("arguments")
                    if isinstance(args, dict):
                        c["arguments"] = json.dumps(args)
                    elif args:
                        c["arguments"] += args
    finally:
        stop.set()
    await fut
    yield "final", response(text, [calls[k] for k in sorted(calls)], fin)


# Models that don't write text replies (speech, pictures, embeddings, guards…), or that only work through an API
# shape the app doesn't speak (OpenAI's Responses-only "pro" and codex models). Hidden unless the user asks for all.
_NOT_CHAT = re.compile(
    r"embed|tts|whisper|transcri|speech|audio|realtime|\blive\b|-live|image|imagen|veo|lyria|dall-e|sora|moderation|"
    r"guard|orpheus|aqa|robotics|computer-use|deep-research|antigravity|genie|nano-banana|translate|search|babbage|"
    r"davinci|codex|-pro(-\d{4}-\d{2}-\d{2})?$|:batch$", re.I)
_SNAPSHOT = re.compile(r"-\d{4}-\d{2}-\d{2}$|-\d{2}-\d{4}$")


def _price(p: dict | None) -> tuple[bool, str]:
    """(free?, "$in / $out per million tokens") from an OpenRouter/Groq pricing block (prices per token, strings)."""
    if not isinstance(p, dict):
        return False, ""
    try:
        i, o = float(p.get("prompt") or 0), float(p.get("completion") or 0)
    except (TypeError, ValueError):
        return False, ""
    if i < 0 or o < 0:    # OpenRouter's auto router
        return False, ""
    if i == 0 and o == 0:
        return True, ""
    f = lambda x: f"${x * 1e6:.2f}".rstrip("0").rstrip(".")   # noqa: E731
    return False, f"{f(i)} / {f(o)}"


def card(pid: str, m: dict) -> dict:
    """One model as Settings shows it: id, readable name, context window, free or price, and whether it chats."""
    mid = str(m.get("id", "")).removeprefix("models/")
    name = str(m.get("name") or m.get("display_name") or "")
    ctx = m.get("context_length") or m.get("context_window") or m.get("max_input_tokens") or m.get("inputTokenLimit")
    free, price = _price(m.get("pricing"))
    out_mod = (m.get("architecture") or {}).get("output_modalities") or m.get("output_modalities")
    chat = not _NOT_CHAT.search(mid) and m.get("active", True) is not False
    if isinstance(out_mod, list) and out_mod:
        chat = chat and "text" in out_mod
    if pid == "openrouter" and mid.endswith(":free"):
        free = True
    created = m.get("created") or m.get("created_at") or 0
    if isinstance(created, str):   # Anthropic: an ISO date
        created = int(created[:10].replace("-", "") or 0)
    return {"id": mid, "name": name if name and name != mid else "", "context": int(ctx) if isinstance(ctx, (int, float)) else 0,
            "free": free, "price": price, "chat": bool(chat), "created": created}


def tidy(pid: str, cards: list[dict]) -> list[dict]:
    """Newest first where the provider says when a model came out, else by name; a dated snapshot whose plain alias
    is also listed counts as not-chat (it is the same model under a fixed name), so the short list stays short."""
    ids = {c["id"] for c in cards}
    for c in cards:
        base = _SNAPSHOT.sub("", c["id"])
        if base != c["id"] and base in ids:
            c["chat"] = False
    return sorted(cards, key=lambda c: (-(c["created"] or 0), (c["name"] or c["id"]).lower()))


async def catalog(pid: str, key: str) -> list[dict]:
    """Every model this key can use, as cards (GET /models)."""
    url = providers.base(pid) + "/models"

    def get() -> list[dict]:
        req = urllib.request.Request(url, headers=_headers(key))
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise _http_error(e) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise _url_error(e, pid, 20) from None
        items = data.get("data", data.get("models")) if isinstance(data, dict) else data
        seen: dict[str, dict] = {}
        for m in items or []:
            if isinstance(m, dict) and m.get("id"):
                c = card(pid, m)
                seen.setdefault(c["id"], c)
        return tidy(pid, list(seen.values()))

    return await asyncio.to_thread(get)


async def models(pid: str, key: str) -> list[str]:
    """The model ids this key can use (GET /models)."""
    url = providers.base(pid) + "/models"

    def get() -> list[str]:
        req = urllib.request.Request(url, headers=_headers(key))
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise _http_error(e) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise _url_error(e, pid, 20) from None
        items = data.get("data") if isinstance(data, dict) else data
        ids = [str(m.get("id", "")) for m in items or [] if isinstance(m, dict)]
        return sorted({i.removeprefix("models/") for i in ids if i})

    return await asyncio.to_thread(get)
