"""Providers that are a subscription rather than an API key: the vendor's own command-line program, signed in on this
computer, is run once per request (Claude Code for a Claude Pro or Max plan, the Gemini CLI for a Google account and
its Google AI plan). Messages, tools and results go in and
come out in the Anthropic shape the rest of the app uses, like app/oai.py; retrying and moving on are app/llm.py's job.

The program is run with its own tools, plugins, MCP servers, settings and memory all off, and in an empty folder: it
is only a way to reach the model. It gets one prompt, so earlier turns are written out as a transcript. The app's
tools (the coach's) can't be handed to the program, so they are described in the system prompt and the model calls
one by writing <tool_call>{"name": …, "input": {…}}</tool_call>; that text is hidden from the reader and becomes a
tool_use block. A JSON schema (tests, plans) goes to Claude Code's structured-output option; the Gemini CLI has none,
so it is asked for in the system prompt and the reply is parsed as JSON (app/llm.py strips a code fence)."""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from . import oai, providers
from .oai import CallError
from .providers import PROVIDERS

OPEN, CLOSE = "<tool_call>", "</tool_call>"
_CALL = re.compile(re.escape(OPEN) + r"\s*(.*?)\s*(?:" + re.escape(CLOSE) + r"|$)", re.S)
# Windows caps a whole command line at 32,767 characters; a longer system prompt goes into the prompt itself
ARG_MAX = 24000
# what the program may be asked for; anything else is left to its default
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
# auth variables that would make Claude Code bill an API account instead of using the plan it is signed in to
_API_AUTH = ("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEYS", "ANTHROPIC_AUTH_TOKEN")


# ------------------------------------------------------------------ prompt
def _text(content) -> str:
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        t = b.get("type")
        if t == "text":
            out.append(b.get("text", ""))
        elif t == "tool_use":
            out.append(OPEN + json.dumps({"name": b["name"], "input": b.get("input", {})}, ensure_ascii=False) + CLOSE)
        elif t == "tool_result":
            rc = b.get("content")
            if isinstance(rc, list):
                rc = "\n".join(x.get("text", "") for x in rc if isinstance(x, dict))
            elif not isinstance(rc, str):
                rc = json.dumps(rc, ensure_ascii=False)
            err = ' error="true"' if b.get("is_error") else ""
            out.append(f'<tool_result id="{b.get("tool_use_id", "")}"{err}>\n{rc}\n</tool_result>')
        elif t == "image":
            out.append("[a picture the user sent; it can't be shown here]")
    return "\n".join(x for x in out if x)


def tool_guide(tools: list | None) -> str:
    if not tools:
        return ""
    lines = ["## Tools",
             "The app you are part of runs tools for you. Native tool calls are not available here: to call a tool, "
             "write it on its own line, exactly like this:",
             OPEN + '{"name": "tool_name", "input": {"argument": "value"}}' + CLOSE,
             "You may write a short sentence before it. To call several tools, write several such lines. After your "
             "tool calls, stop and write nothing else: the app runs them and sends the results back as <tool_result> "
             "blocks, and then you continue. Never write a <tool_result> yourself, and never show tool_call lines as "
             "an example to the user. The tools (each input is a JSON Schema):"]
    for t in tools:
        lines.append(f"- {t['name']}: {t.get('description', '')}\n  input: "
                     + json.dumps(t.get("input_schema", {}), ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines)


def prompt(messages: list) -> str:
    """One prompt from the conversation: a lone question as it is, a longer exchange as a transcript."""
    if len(messages) == 1 and messages[0]["role"] == "user":
        return _text(messages[0]["content"])
    head = {"user": "### User", "assistant": "### Assistant (you)", "system": "### Note from the app (not the user)"}
    parts = ["The conversation so far is below. Write only your next reply as the assistant: no heading, and don't "
             "repeat what was already said.", ""]
    for m in messages:
        parts += [head.get(m["role"], "### " + m["role"]), _text(m["content"]), ""]
    return "\n".join(parts).rstrip() + "\n"


def system_text(system, tools) -> str:
    s = system if isinstance(system, str) else "\n\n".join(b.get("text", "") for b in system or [])
    return "\n\n".join(x for x in (s, tool_guide(tools)) if x)


class Visible:
    """Text as the reader should see it while it streams: everything before the first tool call. A tail that could be
    the start of "<tool_call>" waits until the next words say whether it is."""

    def __init__(self):
        self.buf, self.sent, self.cut = "", 0, False

    def feed(self, delta: str) -> str:
        self.buf += delta
        if self.cut:
            return ""
        i = self.buf.find(OPEN)
        if i >= 0:
            self.cut = True
            return self._upto(i)
        safe = len(self.buf)
        for k in range(min(len(OPEN) - 1, len(self.buf)), 0, -1):
            if OPEN.startswith(self.buf[-k:]):
                safe -= k
                break
        return self._upto(safe)

    def rest(self) -> str:
        return "" if self.cut else self._upto(len(self.buf))

    def _upto(self, i: int) -> str:
        out, self.sent = self.buf[self.sent:i], max(self.sent, i)
        return out


def split_calls(text: str) -> tuple[str, list[dict]]:
    """(the text before the first tool call, the calls). A call whose JSON doesn't parse is dropped."""
    i = text.find(OPEN)
    if i < 0:
        return text, []
    calls = []
    for m in _CALL.finditer(text, i):
        try:
            c = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(c, dict) and isinstance(c.get("name"), str):
            inp = c.get("input", c.get("arguments", {}))
            calls.append({"id": "call_" + uuid.uuid4().hex[:12], "name": c["name"],
                          "arguments": inp if isinstance(inp, dict) else {}})
    return text[:i].rstrip(), calls


# ------------------------------------------------------------------ Claude Code
def _claude_argv(exe: str, model: str, system: str, effort: str, schema: dict | None) -> tuple[list[str], bool]:
    """(the command, whether the system prompt went on it)."""
    argv = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--safe-mode", "--disable-slash-commands",
            "--no-session-persistence", "--model", model]
    if effort in EFFORTS:
        argv += ["--effort", effort]
    if schema:
        argv += ["--json-schema", json.dumps(schema, separators=(",", ":"))]
    on_line = bool(system) and len(system) <= ARG_MAX and not _cmd_wrapper(exe)
    if on_line:
        argv += ["--system-prompt", system]
    elif not system:
        argv += ["--system-prompt", "You are a helpful assistant."]
    return argv, on_line


def _claude_error(text: str, limit: dict | None) -> CallError:
    low = text.lower()
    if limit and limit.get("status") == "rejected" or any(w in low for w in ("usage limit", "hit your limit",
                                                                              "limit reached", "rate limit")):
        when = (limit or {}).get("resetsAt")
        until = f"; it resets at {time.strftime('%H:%M', time.localtime(when))}" if when else ""
        return CallError("quota", f"the plan's usage limit is used up{until}")
    if any(w in low for w in ("/login", "not logged in", "log in", "invalid api key", "oauth", "authentication",
                              "unauthorized", "401")):
        return CallError("auth", "Claude Code isn't signed in to your plan: run claude in a terminal and sign in "
                                 "with /login")
    if "model" in low and any(w in low for w in ("not found", "invalid", "not available", "does not exist")):
        return CallError("request", f"the model wasn't accepted ({text.strip()[:200]}); pick another in Settings → "
                                    "AI providers")
    if "credit balance" in low:
        return CallError("billing", "Claude Code is using an API account with no credit, not your plan")
    return CallError("busy", f"Claude Code failed ({text.strip()[:240] or 'no message'})")


class _Run:
    """One run of a program: the prompt goes in on stdin, JSON lines come out (events()), stderr is kept for the error
    message. The program is killed if the caller stops reading."""

    def __init__(self, argv: list[str], env: dict, body: str, stall: float, cwd: Path | None = None):
        self.argv, self.env, self.body, self.stall, self.cwd = argv, env, body, stall, cwd
        self.stderr, self.said = "", False   # said: words already went out (a failure then restarts the reply)

    async def events(self) -> AsyncIterator[dict]:
        proc = await _spawn(self.argv, self.env, self.cwd)
        errs = asyncio.ensure_future(proc.stderr.read())   # drained alongside, so a chatty stderr can't block it
        try:
            proc.stdin.write(self.body.encode())
            await proc.stdin.drain()
            proc.stdin.close()
            while True:
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), self.stall)
                except asyncio.TimeoutError:
                    raise CallError("stalled", f"no answer for {self.stall:.0f} s", self.said) from None
                if not line:
                    break
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(ev, dict):
                    yield ev
            await proc.wait()
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            self.stderr = (await errs).decode(errors="replace")

    def fail(self, e: CallError) -> CallError:
        e.emitted = self.said
        return e


def _env(drop: tuple[str, ...], **extra) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(extra)
    return env


def _cmd_wrapper(exe: str) -> bool:
    """A .cmd wrapper (Windows) gets nothing free-form on its command line: cmd.exe would read the text as commands."""
    return exe.lower().endswith((".cmd", ".bat"))


async def _claude(exe, model, system, messages, tools, effort, schema, stall) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("text", delta), ("json", delta) for structured output, then ("final", (text, stop, refusal))."""
    sys_text = system_text(system, tools)
    argv, on_line = _claude_argv(exe, model, sys_text, effort, schema)
    body = prompt(messages)
    if sys_text and not on_line:
        body = f"<instructions>\n{sys_text}\n</instructions>\n\n{body}"
    run = _Run(argv, _env(_API_AUTH), body, stall)
    text, stop, limit, result = "", None, None, None
    async for ev in run.events():
        t = ev.get("type")
        if t == "stream_event":
            e = ev.get("event") or {}
            if e.get("type") == "content_block_delta":
                d = e.get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    text += d["text"]
                    run.said = True
                    yield "text", d["text"]
                elif d.get("type") == "input_json_delta" and schema and d.get("partial_json"):
                    run.said = True
                    yield "json", d["partial_json"]
            elif e.get("type") == "message_delta":
                stop = (e.get("delta") or {}).get("stop_reason") or stop
        elif t == "rate_limit_event":
            limit = ev.get("rate_limit_info") or limit
        elif t == "result":
            result = ev
    if result is None or result.get("is_error") or result.get("subtype") not in (None, "success"):
        why = " ".join(str(x) for x in [(result or {}).get("result") or "", *((result or {}).get("errors") or []),
                                        run.stderr] if x)
        raise run.fail(_claude_error(why, limit))
    stop = result.get("stop_reason") or stop
    if schema:
        structured = result.get("structured_output")
        text = json.dumps(structured, ensure_ascii=False) if structured is not None else (result.get("result") or "")
        yield "final", (text, "end_turn", stop == "refusal")
        return
    yield "final", (text, stop, stop == "refusal")


# ------------------------------------------------------------------ Gemini CLI
# Its own tools are switched off by an allowlist that names no tool; MCP servers by allowing none by name. These go in
# workspace settings of the run's own folder, which the program reads on top of the user's (sign-in included).
_GEMINI_SETTINGS = {"tools": {"core": ["none"]}, "mcp": {"allowed": ["none"]}, "model": {"maxSessionTurns": 4}}
# keys that would make the Gemini CLI bill an API key instead of the Google account it is signed in with
_GEMINI_AUTH = ("GEMINI_API_KEY", "GEMINI_API_KEYS", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI",
                "GOOGLE_GENAI_USE_GCA", "GEMINI_SYSTEM_MD")


def _gemini_error(text: str) -> CallError:
    low = text.lower()
    if any(w in low for w in ("resource_exhausted", "quota", "429", "rate limit", "usage limit")):
        return CallError("quota", "the Google account's daily Gemini limit is used up (it resets the next day)")
    if any(w in low for w in ("auth method", "login", "log in", "sign in", "credentials", "unauthenticated", "401",
                              "permission_denied", "api key")):
        return CallError("auth", "the Gemini CLI isn't signed in: run gemini in a terminal and choose Sign in with "
                                 "Google")
    if "model" in low and any(w in low for w in ("not found", "invalid", "not available", "does not exist")):
        return CallError("request", f"the model wasn't accepted ({text.strip()[:200]}); pick another in Settings → "
                                    "AI providers")
    if any(w in low for w in ("fetch failed", "enotfound", "econnrefused", "etimedout", "network")):
        return CallError("offline", "the Gemini CLI couldn't reach Google")
    return CallError("busy", f"the Gemini CLI failed ({text.strip()[:240] or 'no message'})")


def schema_guide(schema: dict | None) -> str:
    if not schema:
        return ""
    return ("## Reply format\nReply with one JSON object that matches this JSON Schema, and nothing else: no words "
            "before or after it, no code fence.\n" + json.dumps(schema, ensure_ascii=False, separators=(",", ":")))


async def _gemini(exe, model, system, messages, tools, effort, schema, stall) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("text", delta) (JSON text too, when a schema was asked for), then ("final", (text, stop, refusal)).
    Each run gets a folder of its own holding the system prompt and .gemini/settings.json (the program reads workspace
    settings from the folder it runs in; a system settings file elsewhere is refused unless root owns it)."""
    import shutil
    sys_text = "\n\n".join(x for x in (system_text(system, tools), schema_guide(schema)) if x)
    here = _workdir() / ("gemini-" + uuid.uuid4().hex[:12])
    (here / ".gemini").mkdir(parents=True)
    sys_file = here / ".gemini" / "system.md"
    sys_file.write_text(sys_text or "You are a helpful assistant.", encoding="utf-8")
    (here / ".gemini" / "settings.json").write_text(json.dumps(_GEMINI_SETTINGS), encoding="utf-8")
    argv = [exe, "--output-format", "stream-json", "--skip-trust", "--allowed-mcp-server-names", "none", "-m", model,
            "-p", "Reply to the input above."]   # plain words: safe on a Windows .cmd wrapper's command line
    env = _env(_GEMINI_AUTH, GEMINI_SYSTEM_MD=str(sys_file))
    run = _Run(argv, env, prompt(messages), stall, cwd=here)
    text, result, errors = "", None, []
    try:
        async for ev in run.events():
            t = ev.get("type")
            if t == "message" and ev.get("role") == "assistant" and isinstance(ev.get("content"), str):
                text += ev["content"]
                run.said = True
                yield "text", ev["content"]
            elif t == "error":
                if ev.get("severity") == "error":
                    errors.append(str(ev.get("message") or ""))
            elif t == "tool_use":   # every tool is off, so this means the switches above stopped working
                errors.append(f"the program tried to use its own tool {ev.get('tool_name') or ''}")
            elif t == "result":
                result = ev
    finally:
        shutil.rmtree(here, ignore_errors=True)
    if result is None or result.get("status") != "success" or (errors and not text):
        err = (result or {}).get("error") or {}
        why = " ".join(x for x in [str(err.get("message") or "") if isinstance(err, dict) else str(err), *errors,
                                   run.stderr] if x)
        raise run.fail(_gemini_error(why))
    yield "final", (text, "end_turn", False)


def _workdir() -> Path:
    d = Path(tempfile.gettempdir()) / "waymark-cli"   # empty but for the files of runs in progress: no project files
    d.mkdir(exist_ok=True)
    return d


async def _spawn(argv: list[str], env: dict, cwd: Path | None = None) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    cwd=cwd or _workdir(), env=env, limit=1 << 24)
    except OSError as e:
        raise CallError("request", f"couldn't start {Path(argv[0]).name} ({e})") from None


# ------------------------------------------------------------------ the calls app/llm.py makes
_RUNNERS = {"claude_code": _claude, "gemini_cli": _gemini}


async def stream(pid: str, key: str, model: str, *, system, messages, tools=None, effort="medium", max_tokens=16000,
                 schema=None):
    """Yields ("text", delta) and ("tool", name), then ("final", response), like oai.stream. max_tokens is the
    program's business."""
    exe = providers.installed(pid)
    if not exe:
        raise CallError("request", f"the {PROVIDERS[pid].command} program isn't installed on this computer")
    stall = oai.stall_sec(pid, effort) + 15   # the program itself takes a few seconds to start
    vis, out = Visible(), None
    async for kind, val in _RUNNERS[pid](exe, model, system, messages, None if schema else tools, effort, schema, stall):
        if kind == "json" or kind == "text" and schema:
            yield "text", val
        elif kind == "text":
            if shown := vis.feed(val):
                yield "text", shown
        else:
            out = val
    text, stop, refused = out
    if schema:
        yield "final", oai.response(text, [], "stop")
        return
    if shown := vis.rest():
        yield "text", shown
    said, calls = split_calls(text)
    for c in calls:
        yield "tool", c["name"]
    resp = oai.response(said, calls, {"end_turn": "stop", "max_tokens": "length", "stop_sequence": "stop",
                                      "tool_use": "stop"}.get(stop or "", stop))
    if refused:
        resp.stop_reason = "refusal"
    yield "final", resp


async def create(pid: str, key: str, model: str, **kw):
    resp = None
    async for kind, val in stream(pid, key, model, **kw):
        if kind == "final":
            resp = val
    return resp


# the models a plan reaches through its program, by alias (always the newest of each line)
_ALIASES = {"claude_code": [("sonnet", "Sonnet (newest)"), ("opus", "Opus (newest)"), ("haiku", "Haiku (newest)"),
                            ("fable", "Fable (newest; Max plans)")],
            "gemini_cli": [("pro", "Gemini Pro (newest)"), ("flash", "Gemini Flash (newest)"),
                           ("flash-lite", "Gemini Flash-Lite (newest)"), ("auto", "Auto (the CLI picks per request)")]}


def catalog(pid: str) -> list[dict]:
    return [{"id": i, "name": n, "context": 0, "free": False, "price": "", "chat": True, "created": 0}
            for i, n in _ALIASES.get(pid, [])]
