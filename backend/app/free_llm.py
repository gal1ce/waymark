"""Free test mode (CTU_LLM=gemini): sends Anthropic-shaped requests to Gemini's OpenAI-compatible
endpoint and returns Anthropic-shaped responses, so the rest of the app doesn't change.
For trying the flows without credits only; the real path is llm.create with the Anthropic SDK."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from types import SimpleNamespace

URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"


def enabled() -> bool:
    return os.environ.get("CTU_LLM") == "gemini" and bool(os.environ.get("GEMINI_API_KEY"))


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if b.get("type") == "text")


def _to_openai(system, messages: list) -> list:
    out = [{"role": "system", "content": _text(system) if not isinstance(system, str) else system}]
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
                    if b.get("extra_content"):  # Gemini thought signature, must be echoed back
                        call["extra_content"] = b["extra_content"]
                    calls.append(call)
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
    return out


class _Block(SimpleNamespace):
    def to_dict(self) -> dict:
        return {k: v for k, v in vars(self).items() if v is not None}


def default_model() -> str:
    return os.environ.get("CTU_FREE_MODEL", "gemini-3.5-flash")


class Unavailable(RuntimeError):
    """This model can't answer right now; another model in the chain may."""


class Quota(Unavailable):
    """HTTP 429: this model's free quota is used up for now. Another model may still have quota."""


class Busy(Unavailable):
    """HTTP 500/502/503/504: Gemini is overloaded or briefly down. Worth a retry, then another model."""


BUSY_CODES = (500, 502, 503, 504)
RETRY_WAIT = (1.5, 4.0)   # seconds before the second and third try on the same model


# When a model is out of quota, the next one in this list is tried, so tests and chat keep working.
FALLBACK = ["gemini-3.5-flash", "gemini-3.5-flash-lite"]


def _chain(model: str | None) -> list[str]:
    first = model or default_model()
    return [first, *[m for m in FALLBACK if m != first]]


def _all_out(models: list[str], last: Exception | None = None) -> RuntimeError:
    if isinstance(last, Busy):
        return RuntimeError(f"Gemini is overloaded right now ({' and '.join(models)} did not answer after retries). "
                            "Nothing was lost: try again in a minute.")
    return RuntimeError(f"Gemini free quota is used up for {' and '.join(models)} (daily or per-minute limit). Try again later.")


def _raise_http(e: urllib.error.HTTPError, model: str):
    msg = _http_error(e, model)
    return Quota(msg) if e.code == 429 else Busy(msg) if e.code in BUSY_CODES else RuntimeError(msg)


def _http_error(e: urllib.error.HTTPError, model: str) -> str:
    if e.code == 429:
        return (f"Gemini free quota is used up for {model} (daily or per-minute limit). "
                "Try again later, or pick another model in the coach settings.")
    if e.code in BUSY_CODES:
        return f"Gemini is overloaded or briefly down ({model}, HTTP {e.code})."
    return f"Gemini HTTP {e.code}: {e.read().decode(errors='replace')[:400]}"


def _post(body: dict) -> dict:
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ['GEMINI_API_KEY']}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise _raise_http(e, body["model"]) from None


def _body(system, messages, tools, effort, max_tokens, schema, model=None) -> dict:
    body: dict = {"model": model or default_model(),
                  "messages": _to_openai(system, messages), "max_tokens": max_tokens,
                  "reasoning_effort": {"low": "low", "medium": "medium"}.get(effort, "high")}
    if tools:
        body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                                           "parameters": t["input_schema"]}} for t in tools]
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}}
    return body


def _response(text: str, calls: list[dict], fin: str | None) -> SimpleNamespace:
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
    stop = "tool_use" if calls else "max_tokens" if fin == "length" else "end_turn"
    return SimpleNamespace(content=content, stop_reason=stop, finish=fin)


async def create(*, system, messages, tools=None, effort="medium", max_tokens=16000, schema=None, model=None):
    chain, last, data = _chain(model), None, None
    for m in chain:
        for attempt in range(len(RETRY_WAIT) + 1):
            try:
                data = await asyncio.to_thread(_post, _body(system, messages, tools, effort, max_tokens, schema, m))
                break
            except Busy as e:
                last = e
                if attempt < len(RETRY_WAIT):
                    await asyncio.sleep(RETRY_WAIT[attempt])
            except Quota as e:
                last = e
                break
        if data is not None:
            break
    else:
        raise _all_out(chain, last)
    ch = data["choices"][0]
    msg = ch["message"]
    calls = [{"id": tc.get("id"), "name": tc["function"]["name"], "arguments": tc["function"].get("arguments"),
              "extra_content": tc.get("extra_content")} for tc in msg.get("tool_calls") or []]
    return _response(msg.get("content") or "", calls, ch.get("finish_reason"))


_END = object()


def _read_sse(body: dict, put, stop: threading.Event) -> None:
    """Runs in a thread: POST with stream=true and hand every SSE data chunk to put()."""
    req = urllib.request.Request(URL, data=json.dumps({**body, "stream": True}).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ['GEMINI_API_KEY']}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
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
        put(_raise_http(e, body["model"]))
    except Exception as e:  # noqa: BLE001 - surfaced to the caller
        put(RuntimeError(f"Gemini stream failed: {e}"))
    finally:
        put(_END)


async def stream(*, system, messages, tools=None, effort="medium", max_tokens=16000, model=None, schema=None):
    """Same events as llm.stream: ("model", id), ("text", delta), ("tool", name), then ("final", response).
    A quota error before anything was streamed moves on to the next model, announced as ("switch", (from, to))."""
    chain, last = _chain(model), None
    for i, m in enumerate(chain):
        yield "model", m
        for attempt in range(len(RETRY_WAIT) + 1):
            emitted = False
            try:
                async for ev in _stream_one(system=system, messages=messages, tools=tools, effort=effort,
                                            max_tokens=max_tokens, model=m, schema=schema):
                    emitted = True
                    yield ev
                return
            except Busy as e:
                if emitted:
                    raise
                last = e
                if attempt < len(RETRY_WAIT):
                    await asyncio.sleep(RETRY_WAIT[attempt])
                    continue
                break
            except Quota as e:
                if emitted:
                    raise
                last = e
                break
        if i + 1 < len(chain):
            yield "switch", (m, chain[i + 1])
    raise _all_out(chain, last)


async def _stream_one(*, system, messages, tools=None, effort="medium", max_tokens=16000, model=None, schema=None):
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()
    put = lambda x: loop.call_soon_threadsafe(q.put_nowait, x)  # noqa: E731
    fut = loop.run_in_executor(None, _read_sse, _body(system, messages, tools, effort, max_tokens, schema, model), put, stop)
    text, calls, fin = "", {}, None
    try:
        while True:
            item = await q.get()
            if item is _END:
                break
            if isinstance(item, Exception):
                raise item
            if isinstance(item, list):
                item = item[0] if item and isinstance(item[0], dict) else {}
            if err := item.get("error"):
                # an error can arrive inside the stream after some text; never treat that as a finished reply
                msg = (err.get("message") if isinstance(err, dict) else str(err)) or "unknown error"
                if (isinstance(err, dict) and err.get("code") in (429, "429")) or "RESOURCE_EXHAUSTED" in str(err):
                    raise Quota(f"Gemini free quota ran out mid-reply ({model}): {msg[:200]}")
                if (isinstance(err, dict) and str(err.get("code")) in {str(c) for c in BUSY_CODES}) or "UNAVAILABLE" in str(err):
                    raise Busy(f"Gemini is overloaded or briefly down ({model}): {msg[:200]}")
                raise RuntimeError(f"Gemini stopped mid-reply ({model}): {msg[:300]}")
            for ch in item.get("choices") or []:
                d = ch.get("delta") or {}
                fin = ch.get("finish_reason") or fin
                if d.get("content"):
                    text += d["content"]
                    yield "text", d["content"]
                for i, tc in enumerate(d.get("tool_calls") or []):
                    k = tc.get("index", i)
                    c = calls.get(k)
                    fn = tc.get("function") or {}
                    if c is None:
                        c = calls[k] = {"id": tc.get("id"), "name": fn.get("name", ""), "arguments": "",
                                        "extra_content": tc.get("extra_content")}
                        if c["name"]:
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
    yield "final", _response(text, [calls[k] for k in sorted(calls)], fin)
