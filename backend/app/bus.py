"""In-process pub/sub so every change reaches open browser tabs over SSE."""
from __future__ import annotations

import asyncio
import json
from typing import Any

_subs: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subs.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subs.discard(q)


def publish(kind: str, data: Any = None) -> None:
    """Safe to call from any thread."""
    msg = json.dumps({"kind": kind, "data": data}, ensure_ascii=False)

    def _put() -> None:
        for q in list(_subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    if _loop is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        _put()
    else:
        _loop.call_soon_threadsafe(_put)
