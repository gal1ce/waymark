"""Thin wrapper over the Anthropic SDK: one place for model, fallbacks, effort."""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

import anthropic

from . import free_llm
from .config import MODEL, has_api_key

_client: anthropic.AsyncAnthropic | None = None


class NoKey(Exception):
    pass


class Truncated(RuntimeError):
    """The reply isn't valid JSON (it broke off). `text` is what arrived, so callers can salvage the complete part."""

    def __init__(self, text: str, finish: str | None):
        self.text, self.finish = text, finish
        super().__init__(f"The reply broke off after {len(text):,} characters (finish reason: {finish or 'none'}).")


def client() -> anthropic.AsyncAnthropic:
    global _client
    if not has_api_key():
        raise NoKey("ANTHROPIC_API_KEY is not set (ctu-app/.env).")
    if _client is None:
        _client = anthropic.AsyncAnthropic(timeout=300.0)
    return _client


def _kwargs(system, messages, tools, effort, max_tokens, schema, model=None) -> dict[str, Any]:
    model = model or MODEL
    output_config: dict[str, Any] = {"effort": effort}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs: dict[str, Any] = dict(
        model=model, max_tokens=max_tokens, system=system, messages=messages,
        output_config=output_config, cache_control={"type": "ephemeral"},
    )
    if "haiku" not in model:  # Haiku has no server-side refusal fallback
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    if tools:
        kwargs["tools"] = tools
    return kwargs


async def create(*, system: Any, messages: list, tools: list | None = None, effort: str = "medium",
                 max_tokens: int = 16000, schema: dict | None = None):
    if free_llm.enabled():
        return await free_llm.create(system=system, messages=messages, tools=tools, effort=effort,
                                     max_tokens=max_tokens, schema=schema)
    return await client().beta.messages.create(**_kwargs(system, messages, tools, effort, max_tokens, schema))


async def stream(*, system: Any, messages: list, tools: list | None = None, effort: str = "medium",
                 max_tokens: int = 16000, model: str | None = None, schema: dict | None = None) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("model", id) when a model is asked (again after a ("switch", (from, to)) on the free provider),
    ("text", delta) and ("tool", name) while it writes, then ("final", response) shaped like create()'s."""
    if free_llm.enabled():
        async for ev in free_llm.stream(system=system, messages=messages, tools=tools, effort=effort,
                                        max_tokens=max_tokens, model=model, schema=schema):
            yield ev
        return
    yield "model", model or MODEL
    async with client().beta.messages.stream(**_kwargs(system, messages, tools, effort, max_tokens, schema, model)) as s:
        async for ev in s:
            if ev.type == "text":
                yield "text", ev.text
            elif ev.type == "content_block_start" and getattr(ev.content_block, "type", None) == "tool_use":
                yield "tool", ev.content_block.name
        yield "final", await s.get_final_message()


def text_of(resp) -> str:
    return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")


async def structured(system: str, prompt: str, schema: dict, effort: str = "medium", max_tokens: int = 16000) -> dict:
    resp = await create(system=system, messages=[{"role": "user", "content": prompt}], schema=schema,
                        effort=effort, max_tokens=max_tokens)
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model refused the request.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("The reply was cut off at max_tokens.")
    return json.loads(text_of(resp))


async def structured_live(system: str, prompt: str, schema: dict, on, effort: str = "medium", max_tokens: int = 16000) -> dict:
    """structured(), streamed: on(kind, value) sees every ("model" | "switch" | "text") event as it happens."""
    resp = None
    async for kind, val in stream(system=system, messages=[{"role": "user", "content": prompt}], effort=effort,
                                  max_tokens=max_tokens, schema=schema):
        if kind == "final":
            resp = val
        else:
            on(kind, val)
    if resp is None:
        raise RuntimeError("The model stopped without a reply.")
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model refused the request.")
    text = text_of(resp)
    if resp.stop_reason == "max_tokens":
        raise Truncated(text, "length")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise Truncated(text, getattr(resp, "finish", None) or resp.stop_reason) from None


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
