"""The AI providers the app can talk to, their keys and the user's choices about them.

Keys live in .env (app/envfile.py), several per provider, comma separated. Everything else (the order providers are
tried in, whether to move on to the next provider at all, the model each provider uses, the local server's address)
is a setting in the database.

How a request is answered (app/llm.py): the first provider in the user's order that is set up is the primary. Its keys
are tried one after the other, starting with the one that answered last; a key that just failed for a reason that
lasts (no credit, refused, rate limit) is skipped for a while. When every key of the primary fails, the next provider
is tried only if the user turned that on (off by default: another provider may cost money or answer differently).

A subscription (kind "cli", app/cli.py) has no keys: it is the vendor's own program, signed in to the user's plan,
switched on in Settings and found on PATH."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from . import db, envfile


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    env: str                       # the .env variable holding the keys (…_API_KEYS; the singular …_API_KEY is read too)
    base: str                      # API root (OpenAI-compatible ones end in /v1 or similar)
    kind: str                      # "anthropic", "openai" (the OpenAI chat-completions shape) or "cli" (app/cli.py)
    keys_url: str = ""             # where a key is made
    needs_key: bool = True
    # Defaults, each checked with real requests on 2026-11-23 (plain reply, JSON schema, tool call) except OpenAI's,
    # whose test account had no credit: gpt-5-mini/nano are OpenAI's standard small models and were listed.
    main: str = ""                 # default model for tests and planning ("" = the user must pick one)
    chat: str = ""                 # default model for the coach chat ("" = same as main)
    shape: str = ""                # loose pattern of a key, to catch a key pasted under the wrong provider
    note: str = ""
    command: str = ""              # kind "cli": the program that is run (signed in to the user's own subscription)


PROVIDERS: dict[str, Provider] = {p.id: p for p in [
    Provider("anthropic", "Anthropic", "ANTHROPIC_API_KEYS", "https://api.anthropic.com", "anthropic",
             "https://platform.claude.com/settings/keys", main="claude-sonnet-5-5", chat="claude-haiku-5-5",
             shape=r"sk-ant-[A-Za-z0-9_\-]{20,}", note="Claude. Paid, prepaid credits."),
    Provider("openai", "OpenAI", "OPENAI_API_KEYS", "https://api.openai.com/v1", "openai",
             "https://platform.openai.com/api-keys", main="gpt-5-mini", chat="gpt-5-nano", shape=r"sk-[A-Za-z0-9_\-]{20,}", note="GPT models. Paid."),
    Provider("openrouter", "OpenRouter", "OPENROUTER_API_KEYS", "https://openrouter.ai/api/v1", "openai",
             "https://openrouter.ai/settings/keys", main="nvidia/nemotron-3.5-lightning:free", shape=r"sk-or-[A-Za-z0-9_\-]{20,}",
             note="Many models behind one key; some are free."),
    Provider("groq", "Groq", "GROQ_API_KEYS", "https://api.groq.com/openai/v1", "openai",
             "https://console.groq.com/keys", main="openai/gpt-oss-120b",
             chat="openai/gpt-oss-20b", shape=r"gsk_[A-Za-z0-9]{20,}", note="Very fast open models; free tier."),
    Provider("gemini", "Gemini", "GEMINI_API_KEYS", "https://generativelanguage.googleapis.com/v1beta/openai", "openai",
             "https://aistudio.google.com/apikey", main="gemini-3.5-flash", chat="gemini-3.5-flash-lite",
             shape=r"AIza[A-Za-z0-9_\-]{20,}", note="Google. Free tier with daily limits."),
    Provider("local", "Local model", "LOCAL_LLM_API_KEYS", "http://localhost:11434/v1", "openai",
             needs_key=False, note="A model on this computer (Ollama, LM Studio, llama.cpp): free, private, as fast as "
                                   "the computer."),
    # Subscriptions, through the vendor's own command-line program (app/cli.py): no key, the program's sign-in.
    Provider("claude_code", "Claude subscription", "", "", "cli", needs_key=False, command="claude",
             main="sonnet", chat="haiku",
             note="Your Claude Pro or Max plan, through Claude Code (the claude command) signed in on this computer. "
                  "No key and no API credit: it counts against the plan's usage limits. A few seconds slower per "
                  "request."),
    Provider("gemini_cli", "Gemini subscription", "", "", "cli", needs_key=False, command="gemini",
             main="pro", chat="flash",
             note="Your Google account (and its Google AI Pro or Ultra plan, if any), through the Gemini CLI (the gemini "
                  "command) signed in on this computer. No key: it counts against the account's daily limits. A few "
                  "seconds slower per request."),
]}
CLI = [pid for pid, p in PROVIDERS.items() if p.kind == "cli"]
ORDER = list(PROVIDERS)


class SetupError(RuntimeError):
    """Something only the user can fix in Settings (no model picked, local server address missing…)."""


# ------------------------------------------------------------------ settings
def _defaults() -> dict:
    """The defaults live here, in code; the user's choices are in the database. Nothing about models is read from
    .env (it holds keys only)."""
    models = {pid: {"main": p.main, "chat": p.chat} for pid, p in PROVIDERS.items()}
    return {"order": list(ORDER), "fallback": False, "models": models, "local_url": PROVIDERS["local"].base,
            "local_on": False, "cli_on": {pid: False for pid in CLI}}


def settings() -> dict:
    d = _defaults()
    s = db.kv_get("ai_settings", {}) or {}
    order = [p for p in s.get("order", []) if p in PROVIDERS]
    d["order"] = order + [p for p in d["order"] if p not in order]
    d["fallback"] = bool(s.get("fallback", False))
    # Stored are only the user's own picks: an empty main or chat means "the default in code", and the coach chat
    # set to follow tests and plans is stored as SAME (shown as "" here, which model() reads as "use main").
    for pid, m in (s.get("models") or {}).items():
        if pid in PROVIDERS and isinstance(m, dict):
            dm = d["models"][pid]
            chat = str(m.get("chat") or "")
            d["models"][pid] = {"main": str(m.get("main") or "") or dm["main"],
                                "chat": "" if chat == SAME else chat or dm["chat"]}
    if isinstance(s.get("local_url"), str) and s["local_url"].strip():
        d["local_url"] = s["local_url"].strip().rstrip("/")
    d["local_on"] = bool(s.get("local_on", False))
    for pid, on in (s.get("cli_on") or {}).items():
        if pid in d["cli_on"]:
            d["cli_on"][pid] = bool(on)
    return d


SAME = "=main"


def _stored_models(models: dict) -> dict:
    """What is written to the database: only what differs from the defaults in code (see settings())."""
    out = {}
    for pid, m in models.items():
        p = PROVIDERS[pid]
        main = "" if m["main"] == p.main else m["main"]
        chat = "" if m["chat"] == p.chat else (SAME if m["chat"] == "" else m["chat"])
        if main or chat:
            out[pid] = {"main": main, "chat": chat}
    return out


def save_settings(order: list[str] | None = None, fallback: bool | None = None, models: dict | None = None,
                  local_url: str | None = None, local_on: bool | None = None,
                  cli_on: dict[str, bool] | None = None) -> dict:
    s = settings()
    if order is not None:
        bad = [p for p in order if p not in PROVIDERS]
        if bad:
            raise SetupError(f"Unknown provider: {', '.join(bad)}.")
        s["order"] = list(dict.fromkeys(order)) + [p for p in ORDER if p not in order]
    if fallback is not None:
        s["fallback"] = bool(fallback)
    for pid, m in (models or {}).items():
        if pid not in PROVIDERS:
            raise SetupError(f"Unknown provider: {pid}.")
        for role in ("main", "chat"):
            if role in m:
                v = " ".join(str(m[role] or "").split())
                if len(v) > 200:
                    raise SetupError("That model name is too long.")
                s["models"][pid][role] = v
    if local_url is not None:
        u = local_url.strip().rstrip("/")
        if u and not re.match(r"^https?://[^\s/]+(/\S*)?$", u):
            raise SetupError("The local server address should look like http://localhost:11434/v1.")
        s["local_url"] = u or PROVIDERS["local"].base
    if local_on is not None:
        s["local_on"] = bool(local_on)
    for pid, on in (cli_on or {}).items():
        if pid not in CLI:
            raise SetupError(f"Unknown provider: {pid}.")
        s["cli_on"][pid] = bool(on)
    db.kv_set("ai_settings", {**s, "models": _stored_models(s["models"])})
    return s


# ------------------------------------------------------------------ keys
def _names(pid: str) -> tuple[str, str]:
    """(plural, singular): GROQ_API_KEYS is the app's name; GROQ_API_KEY, the usual one, is read as well."""
    env = PROVIDERS[pid].env
    return env, env.removesuffix("S")


def keys(pid: str) -> list[str]:
    if not PROVIDERS[pid].env:   # a subscription program has no keys
        return []
    plural, single = _names(pid)
    return list(dict.fromkeys(envfile.split(envfile.get(plural)) + envfile.split(envfile.get(single))))


def _line_for_new(pid: str) -> str:
    """The variable a new key is appended to: the plural line if the file has it, else the singular one if the file
    has that, else a new plural line."""
    plural, single = _names(pid)
    have = envfile.values()
    return plural if plural in have or single not in have else single


def hint(key: str) -> str:
    return "…" + key[-4:] if len(key) > 8 else "…"


def base(pid: str) -> str:
    return settings()["local_url"] if pid == "local" else PROVIDERS[pid].base


def ready(pid: str, s: dict | None = None) -> bool:
    """Set up enough to be asked: keys (or, for the local model, switched on; for a subscription, switched on and its
    program found)."""
    s = s or settings()
    if pid == "local":
        return bool(s["local_on"])
    if PROVIDERS[pid].kind == "cli":
        return bool(s["cli_on"].get(pid)) and bool(installed(pid))
    return bool(keys(pid))


def installed(pid: str) -> str:
    """Where the provider's program is ("" when it isn't installed, or the provider has none). Besides PATH, the
    folders these programs install to for one user are looked in: an app started from the desktop may not have them
    on its PATH."""
    import os
    import shutil
    from pathlib import Path
    cmd = PROVIDERS[pid].command
    if not cmd:
        return ""
    home = Path.home()
    extra = [home / ".local" / "bin", home / ".claude" / "local", home / ".npm-global" / "bin", home / "bin"]
    if os.name == "nt" and os.environ.get("APPDATA"):
        extra.append(Path(os.environ["APPDATA"]) / "npm")
    return shutil.which(cmd) or shutil.which(cmd, path=os.pathsep.join(map(str, extra))) or ""


def chain() -> list[str]:
    """The providers a request may use, in order: the primary alone, or every ready one when fallback is on."""
    s = settings()
    ok = [p for p in s["order"] if ready(p, s)]
    return ok if s["fallback"] else ok[:1]


def primary() -> str | None:
    s = settings()
    return next((p for p in s["order"] if ready(p, s)), None)


def any_ready() -> bool:
    return primary() is not None


def model(pid: str, role: str = "main") -> str:
    m = settings()["models"][pid]
    name = (m.get("chat") if role == "chat" else "") or m.get("main") or ""
    if not name:
        raise SetupError(f"No model is chosen for {PROVIDERS[pid].label}. Pick one in Settings → AI providers.")
    return name


def add_key(pid: str, key: str) -> list[str]:
    key = key.strip()
    have = keys(pid)
    if key in have:
        raise SetupError(f"That key is already saved for {PROVIDERS[pid].label} (key {have.index(key) + 1}).")
    # the specific shapes (sk-ant-, sk-or-, gsk_, AIza) say whose key it is; OpenAI's plain sk- says nothing
    for other, p in PROVIDERS.items():
        if other not in (pid, "openai") and p.shape and re.fullmatch(p.shape, key):
            raise SetupError(f"That looks like a {p.label} key, not a {PROVIDERS[pid].label} one.")
    name = _line_for_new(pid)
    envfile.set_list(name, envfile.split(envfile.get(name)) + [key])
    return keys(pid)


def remove_key(pid: str, index: int) -> list[str]:
    have = keys(pid)
    if not 0 <= index < len(have):
        raise SetupError("No such key.")
    gone = have.pop(index)
    for name in _names(pid):
        line = envfile.split(envfile.get(name))
        if gone in line:
            envfile.set_list(name, [k for k in line if k != gone])
    _health.pop(gone, None)
    return have


# ------------------------------------------------------------------ key health (this run only)
# Why a key failed and until when it is skipped. A key that keeps failing is still tried when nothing else is left.
COOL = {"auth": 1800, "billing": 1800, "quota": 300, "busy": 45, "stalled": 60, "cut": 30, "offline": 20}


@dataclass
class Health:
    ok: bool | None = None
    reason: str = ""
    kind: str = ""
    until: float = 0.0
    ts: float = field(default_factory=time.time)


_health: dict[str, Health] = {}
_last: dict[str, str] = {}


def mark_ok(pid: str, key: str) -> None:
    _health[key] = Health(ok=True)
    _last[pid] = key


def mark_bad(key: str, kind: str, reason: str) -> None:
    _health[key] = Health(ok=False, kind=kind, reason=reason, until=time.time() + COOL.get(kind, 30))


def try_order(pid: str) -> list[str]:
    """This provider's keys in the order to try now: the last one that answered first, then the rest in file order;
    keys resting after a failure go to the back."""
    ks = keys(pid) or ([""] if not PROVIDERS[pid].needs_key else [])
    last = _last.get(pid)
    if last in ks:
        i = ks.index(last)
        ks = ks[i:] + ks[:i]
    now = time.time()
    fresh = [k for k in ks if _health.get(k, Health()).until <= now]
    return fresh + [k for k in ks if k not in fresh]


def key_status(pid: str) -> list[dict]:
    out = []
    for i, k in enumerate(keys(pid)):
        h = _health.get(k)
        out.append({"index": i, "hint": hint(k), "ok": h.ok if h else None, "reason": h.reason if h else "",
                    "resting": bool(h and h.until > time.time())})
    return out


def migrate_legacy_key() -> None:
    """Before keys lived in .env, a key entered in the app was kept in the data folder as `api-key`. Move it to .env
    (at the end of the Anthropic line) once, then drop the old file."""
    from .config import DATA_DIR
    old = DATA_DIR / "api-key"
    try:
        k = old.read_text().strip()
    except OSError:
        return
    if re.fullmatch(PROVIDERS["anthropic"].shape, k) and k not in keys("anthropic"):
        add_key("anthropic", k)
    old.unlink(missing_ok=True)


def view() -> dict:
    """Everything Settings → AI providers shows. Keys appear only as their last four characters."""
    s = settings()
    prim = primary()
    out = []
    for pid in s["order"]:
        p = PROVIDERS[pid]
        out.append({"id": pid, "label": p.label, "note": p.note, "keys_url": p.keys_url, "needs_key": p.needs_key,
                    "env": p.env, "ready": ready(pid, s), "primary": pid == prim, "keys": key_status(pid),
                    "models": s["models"][pid], "default_models": {"main": p.main, "chat": p.chat},
                    "base": base(pid), "kind": p.kind, "command": p.command,
                    "on": bool(s["cli_on"].get(pid)) if p.kind == "cli" else None,
                    "installed": bool(installed(pid)) if p.kind == "cli" else None})
    return {"providers": out, "fallback": s["fallback"], "local_url": s["local_url"], "local_on": s["local_on"],
            "primary": prim, "env_file": str(envfile.path())}
