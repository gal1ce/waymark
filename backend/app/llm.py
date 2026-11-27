"""Every model request in the app goes through here: which provider, which key, which model, and what happens when
one of them fails (app/providers.py has the rules, the user's order and the keys).

For each request: the primary provider's keys are tried one after the other. A key that fails is skipped for this
request (and rests for a while if the reason lasts); a busy service gets two short retries. When all of the primary's
keys fail, the next provider is tried only if the user turned that on. A reply that breaks off after it started is
written again from the start by the next key or provider ("restart" event; the coach clears what it showed). When
nothing answers, the error says, per provider and key, what went wrong."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, AsyncIterator

import anthropic

from . import cli, oai, providers
from .oai import CallError
from .providers import PROVIDERS


class NoKey(Exception):
    """No provider is set up at all."""


class Unavailable(RuntimeError):
    """Every key of every provider allowed to answer failed. The message says why, per key."""


class Truncated(RuntimeError):
    """The reply isn't valid JSON (it broke off). `text` is what arrived, so callers can salvage the complete part."""

    def __init__(self, text: str, finish: str | None):
        self.text, self.finish = text, finish
        super().__init__(f"The reply broke off after {len(text):,} characters (finish reason: {finish or 'none'}).")


BUSY_WAIT = (1.5, 4.0)   # seconds before the second and third try of a busy service (per request and provider)
NO_KEY = "No AI provider is set up yet. Add a key in Settings → AI providers."


# ------------------------------------------------------------------ Anthropic
def workspace_headers() -> dict[str, str]:
    """A key that isn't scoped to one workspace must name the workspace on every request (Console → Settings →
    Workspaces, the ID column). ANTHROPIC_WORKSPACE_ID in .env sets it; a workspace-scoped key needs nothing."""
    from . import envfile
    w = envfile.get("ANTHROPIC_WORKSPACE_ID").strip()
    return {"anthropic-workspace-id": w} if w else {}


_clients: dict[str, anthropic.AsyncAnthropic] = {}


def _anthropic(key: str) -> anthropic.AsyncAnthropic:
    c = _clients.get(key)
    if c is None:
        c = _clients[key] = anthropic.AsyncAnthropic(api_key=key, timeout=300.0, max_retries=0,
                                                     default_headers=workspace_headers())
    return c


# models that take effort only up to max without xhigh (xhigh came with Opus 4.7)
_NO_XHIGH = re.compile(r"claude-(opus|sonnet)-4-[0-6]\b")


def _kwargs(model, system, messages, tools, effort, max_tokens, schema) -> dict[str, Any]:
    if effort == "xhigh" and _NO_XHIGH.search(model):
        effort = "high"
    output_config: dict[str, Any] = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs: dict[str, Any] = dict(model=model, max_tokens=max_tokens, system=system, messages=messages,
                                  output_config=output_config, cache_control={"type": "ephemeral"})
    if "haiku" not in model:  # Haiku has no server-side refusal fallback
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    if tools:
        kwargs["tools"] = tools
    return kwargs


def _anthropic_error(e: Exception, emitted: bool = False) -> CallError:
    msg = getattr(e, "message", None) or str(e)
    body = getattr(e, "body", None)
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        msg = body["error"].get("message") or msg
    msg = str(msg)[:240]
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return CallError("auth", f"the key was refused ({msg})", emitted)
    if isinstance(e, anthropic.RateLimitError):
        return CallError("quota", f"rate limit reached (429: {msg})", emitted)
    if isinstance(e, anthropic.BadRequestError):
        if "credit balance" in msg.lower():
            return CallError("billing", "no credit left: buy credits on platform.claude.com/settings/billing", emitted)
        if "not scoped to a workspace" in msg:
            return CallError("auth", "the key isn't tied to a workspace (make a key for a workspace, or set "
                                     "ANTHROPIC_WORKSPACE_ID in .env)", emitted)
        return CallError("request", f"the request was refused ({msg})", emitted)
    if isinstance(e, anthropic.NotFoundError):
        return CallError("request", f"not found ({msg}); check the model in Settings → AI providers", emitted)
    if isinstance(e, anthropic.APITimeoutError):
        return CallError("stalled", "no answer in time", emitted)
    if isinstance(e, anthropic.APIConnectionError):
        return CallError("offline", "couldn't connect to Anthropic", emitted)
    if isinstance(e, anthropic.APIStatusError):
        return CallError("busy", f"the service is overloaded or down ({e.status_code})", emitted)
    return CallError("busy", f"unexpected error ({type(e).__name__}: {msg})", emitted)


async def _anthropic_stream(key, model, *, system, messages, tools, effort, max_tokens, schema):
    emitted = False
    try:
        async with _anthropic(key).beta.messages.stream(**_kwargs(model, system, messages, tools, effort, max_tokens,
                                                                  schema)) as s:
            async for ev in s:
                if ev.type == "text":
                    emitted = True
                    yield "text", ev.text
                elif ev.type == "content_block_start" and getattr(ev.content_block, "type", None) == "tool_use":
                    emitted = True
                    yield "tool", ev.content_block.name
            yield "final", await s.get_final_message()
    except anthropic.APIError as e:
        raise _anthropic_error(e, emitted) from None


async def _anthropic_create(key, model, *, system, messages, tools, effort, max_tokens, schema):
    try:
        return await _anthropic(key).beta.messages.create(**_kwargs(model, system, messages, tools, effort, max_tokens,
                                                                    schema))
    except anthropic.APIError as e:
        raise _anthropic_error(e) from None


# ------------------------------------------------------------------ the router
class _Run:
    """One request's walk over providers and keys, and the record of what failed, for the final message."""

    def __init__(self, role: str):
        self.role = role
        self.failed: list[tuple[str, str, str]] = []   # (provider label, key label, reason)
        self.skipped: list[str] = []                    # providers left out because fallback is off

    def attempts(self):
        chain = providers.chain()
        if not chain:
            raise NoKey(NO_KEY)
        s = providers.settings()
        if not s["fallback"]:
            self.skipped = [PROVIDERS[p].label for p in s["order"] if p != chain[0] and providers.ready(p, s)]
        for pid in chain:
            try:
                model = providers.model(pid, self.role)
            except providers.SetupError as e:
                self.failed.append((PROVIDERS[pid].label, "", str(e)))
                continue
            ks = providers.try_order(pid)
            for key in ks:
                yield pid, key, model, self._key_label(pid, key)

    @staticmethod
    def _key_label(pid: str, key: str) -> str:
        if not key:
            return ""
        all_keys = providers.keys(pid)
        return f"key {all_keys.index(key) + 1} ({providers.hint(key)})" if key in all_keys else providers.hint(key)

    def fail(self, pid: str, key: str, label: str, e: CallError) -> None:
        self.failed.append((PROVIDERS[pid].label, label, str(e)))
        if key and e.kind != "request":
            providers.mark_bad(key, e.kind, str(e))

    def error(self) -> Unavailable:
        lines = ["No AI provider answered."]
        by: dict[str, list[str]] = {}
        for prov, keyl, reason in self.failed:
            by.setdefault(prov, []).append(f"{keyl}: {reason}" if keyl else reason)
        for prov, rs in by.items():
            lines.append(f"• {prov}: " + "; ".join(rs) + ".")
        if self.skipped:
            lines.append(f"Not tried: {', '.join(self.skipped)}, because moving on to other providers is off "
                         "(Settings → AI providers).")
        return Unavailable("\n".join(lines))


def _label(pid: str, model: str, keyl: str) -> str:
    return f"{PROVIDERS[pid].label} · {model}" + (f" · {keyl}" if keyl and len(providers.keys(pid)) > 1 else "")


def _stamp(resp, pid: str, model: str) -> Any:
    try:
        resp.provider, resp.model_used = pid, model
    except Exception:  # noqa: BLE001 - a frozen SDK object; the label is optional
        pass
    return resp


async def create(*, system: Any, messages: list, tools: list | None = None, effort: str = "medium",
                 max_tokens: int = 16000, schema: dict | None = None, role: str = "main"):
    run = _Run(role)
    attempts = list(run.attempts())
    busy_left = {pid: len(BUSY_WAIT) for pid in PROVIDERS}
    dead: set[str] = set()
    i = 0
    while i < len(attempts):
        pid, key, model, keyl = attempts[i]
        if pid in dead:
            i += 1
            continue
        call = _anthropic_create if PROVIDERS[pid].kind == "anthropic" else (
            lambda k, m, **kw: (cli if PROVIDERS[pid].kind == "cli" else oai).create(pid, k, m, **kw))
        try:
            resp = await call(key, model, system=system, messages=messages, tools=tools, effort=providers.effort(pid, effort, role),
                              max_tokens=max_tokens, schema=schema)
        except CallError as e:
            if e.kind == "busy" and busy_left[pid]:
                await asyncio.sleep(BUSY_WAIT[len(BUSY_WAIT) - busy_left[pid]])
                busy_left[pid] -= 1
                continue
            run.fail(pid, key, keyl, e)
            if e.kind in ("request", "offline"):
                dead.add(pid)
            i += 1
            continue
        if getattr(resp, "stop_reason", None) == "cut" and i + 1 < len(attempts):
            run.fail(pid, key, keyl, CallError("cut", "the reply broke off mid-sentence"))
            i += 1
            continue
        if key:
            providers.mark_ok(pid, key)
        return _stamp(resp, pid, model)
    raise run.error()


async def stream(*, system: Any, messages: list, tools: list | None = None, effort: str = "medium",
                 max_tokens: int = 16000, schema: dict | None = None, role: str = "main",
                 model: str | None = None) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("model", label) when a provider/key/model is asked, ("switch", (from, to)) when the next one is
    tried, ("restart", reason) when a reply that had started must be written again (drop what was shown),
    ("text", delta) and ("tool", name) while it writes, then ("final", response). `model` is ignored (kept so old
    callers don't break); the model comes from Settings → AI providers."""
    run = _Run(role)
    attempts = list(run.attempts())
    busy_left = {pid: len(BUSY_WAIT) for pid in PROVIDERS}
    dead: set[str] = set()
    prev = None
    i = 0
    while i < len(attempts):
        pid, key, mdl, keyl = attempts[i]
        if pid in dead:
            i += 1
            continue
        label = _label(pid, mdl, keyl)
        if prev and prev != label:
            yield "switch", (prev, label)
        prev = label
        yield "model", label
        eff = providers.effort(pid, effort, role)
        gen = (_anthropic_stream(key, mdl, system=system, messages=messages, tools=tools, effort=eff,
                                 max_tokens=max_tokens, schema=schema)
               if PROVIDERS[pid].kind == "anthropic" else
               (cli if PROVIDERS[pid].kind == "cli" else oai).stream(pid, key, mdl, system=system, messages=messages, tools=tools, effort=eff,
                          max_tokens=max_tokens, schema=schema))
        emitted, resp = False, None
        try:
            async for kind, val in gen:
                if kind == "final":
                    resp = val
                else:
                    emitted = True
                    yield kind, val
        except CallError as e:
            if e.kind == "busy" and busy_left[pid] and not (emitted or e.emitted):
                await asyncio.sleep(BUSY_WAIT[len(BUSY_WAIT) - busy_left[pid]])
                busy_left[pid] -= 1
                continue
            run.fail(pid, key, keyl, e)
            if e.kind in ("request", "offline"):
                dead.add(pid)
            if (emitted or e.emitted) and _more(attempts, i, dead):
                yield "restart", f"{PROVIDERS[pid].label} stopped mid-reply ({e}); writing it again"
            i += 1
            continue
        if resp is not None and getattr(resp, "stop_reason", None) == "cut" and _more(attempts, i, dead):
            run.fail(pid, key, keyl, CallError("cut", "the reply broke off mid-sentence"))
            yield "restart", f"{PROVIDERS[pid].label} broke off mid-reply; writing it again"
            i += 1
            continue
        if resp is None:
            run.fail(pid, key, keyl, CallError("cut", "the stream ended without a reply"))
            i += 1
            continue
        if key:
            providers.mark_ok(pid, key)
        yield "final", _stamp(resp, pid, mdl)
        return
    raise run.error()


def _more(attempts: list, i: int, dead: set[str]) -> bool:
    return any(a[0] not in dead for a in attempts[i + 1:])


# ------------------------------------------------------------------ helpers the app uses
def text_of(resp) -> str:
    return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")


async def structured(system: str, prompt: str, schema: dict, effort: str = "medium", max_tokens: int = 16000,
                     role: str = "main") -> dict:
    resp = await create(system=system, messages=[{"role": "user", "content": prompt}], schema=schema,
                        effort=effort, max_tokens=max_tokens, role=role)
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model refused the request.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("The reply was cut off at max_tokens.")
    if resp.stop_reason == "cut":
        raise RuntimeError("The model stopped mid-reply (it is probably overloaded). Try again in a minute.")
    try:
        return json.loads(_json_text(text_of(resp)))
    except json.JSONDecodeError:
        raise RuntimeError("The model's reply wasn't the JSON that was asked for. Try again, or pick a stronger "
                           "model in Settings → AI providers.") from None


async def structured_live(system: str, prompt: str, schema: dict, on, effort: str = "medium", max_tokens: int = 16000,
                          role: str = "main") -> dict:
    """structured(), streamed: on(kind, value) sees every ("model" | "switch" | "restart" | "text") event."""
    resp = None
    async for kind, val in stream(system=system, messages=[{"role": "user", "content": prompt}], effort=effort,
                                  max_tokens=max_tokens, schema=schema, role=role):
        if kind == "final":
            resp = val
        else:
            on(kind, val)
    if resp is None:
        raise RuntimeError("The model stopped without a reply.")
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model refused the request.")
    text = text_of(resp)
    if resp.stop_reason in ("max_tokens", "cut"):
        raise Truncated(text, "length" if resp.stop_reason == "max_tokens" else getattr(resp, "finish", None))
    try:
        return json.loads(_json_text(text))
    except json.JSONDecodeError:
        raise Truncated(text, getattr(resp, "finish", None) or resp.stop_reason) from None


def _json_text(t: str) -> str:
    """Some models wrap JSON in a ``` fence even when asked for JSON only."""
    t = t.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0]
    return t.strip()


def strict(schema: dict) -> dict:
    """Make every object schema strict: all properties required, no extras."""
    if schema.get("type") == "object":
        props = schema.get("properties", {})
        schema["required"] = list(props.keys())
        schema["additionalProperties"] = False
        for v in props.values():
            strict(v)
    elif schema.get("type") == "array" and isinstance(schema.get("items"), dict):
        strict(schema["items"])
    return schema


def label_of(resp) -> str:
    pid = getattr(resp, "provider", None)
    return f"{PROVIDERS[pid].label} · {getattr(resp, 'model_used', '')}" if pid in PROVIDERS else ""


async def ask_one(pid: str, key: str, model: str) -> str:
    """One tiny request with one key, no fallback: for the key test in Settings."""
    kw = dict(system="Reply with one word.", messages=[{"role": "user", "content": "Say: ok"}], tools=None,
              effort="low", max_tokens=200, schema=None)
    if PROVIDERS[pid].kind == "anthropic":
        resp = await _anthropic_create(key, model, **kw)
    else:
        resp = await (cli if PROVIDERS[pid].kind == "cli" else oai).create(pid, key, model, **kw)
    return text_of(resp)


_catalogs: dict[tuple[str, str], tuple[float, list[dict]]] = {}
CATALOG_TTL = 600


async def catalog(pid: str, key: str | None = None, fresh: bool = False) -> list[dict]:
    """Every model a key of this provider can use, as cards (oai.card), kept for ten minutes."""
    if key is None:
        ks = providers.keys(pid)
        key = ks[0] if ks else ""
    if PROVIDERS[pid].kind == "cli":
        return await cli.catalog(pid, fresh)
    if PROVIDERS[pid].needs_key and not key:
        raise providers.SetupError(f"Add a {PROVIDERS[pid].label} key first.")
    slot = (pid, providers.base(pid))
    hit = _catalogs.get(slot)
    if hit and not fresh and time.time() - hit[0] < CATALOG_TTL:
        return hit[1]
    if PROVIDERS[pid].kind == "anthropic":
        try:
            page = await _anthropic(key).models.list(limit=100)
        except anthropic.APIError as e:
            raise _anthropic_error(e) from None
        cards = oai.tidy(pid, [oai.card(pid, m.model_dump(mode="json")) for m in page.data])
    else:
        cards = await oai.catalog(pid, key)
    _catalogs[slot] = (time.time(), cards)
    return cards


async def list_models(pid: str, key: str | None = None) -> list[str]:
    """The models one of this provider's keys can use (the first key when none is given)."""
    if key is None:
        ks = providers.keys(pid)
        key = ks[0] if ks else ""
    if PROVIDERS[pid].kind == "cli":
        return [c["id"] for c in await cli.catalog(pid)]
    if PROVIDERS[pid].needs_key and not key:
        raise providers.SetupError(f"Add a {PROVIDERS[pid].label} key first.")
    if PROVIDERS[pid].kind == "anthropic":
        try:
            page = await _anthropic(key).models.list(limit=100)
        except anthropic.APIError as e:
            raise _anthropic_error(e) from None
        return sorted(m.id for m in page.data)
    return await oai.models(pid, key)

