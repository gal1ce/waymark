"""AI providers: keys in .env, the walk over keys and providers, what the user is told when nothing answers."""
from __future__ import annotations

import asyncio
import http.server
import os
import stat
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import envfile, llm, main, oai, providers
from app.oai import CallError

H = {"x-ctu": "1"}
ANT1, ANT2 = "sk-ant-api03-" + "a" * 40, "sk-ant-api03-" + "b" * 40
GROQ = "gsk_" + "g" * 40


@pytest.fixture
def env(fresh, monkeypatch, tmp_path):
    f = tmp_path / ".env"
    monkeypatch.setenv("CTU_ENV_FILE", str(f))
    for p in providers.PROVIDERS.values():
        monkeypatch.delenv(p.env, raising=False)
        monkeypatch.delenv(p.env.removesuffix("S"), raising=False)
    monkeypatch.setattr(llm, "BUSY_WAIT", (0, 0))
    providers._health.clear()
    providers._last.clear()
    envfile._cache = None
    yield f
    envfile._cache = None


def _reply(text="ok"):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text, to_dict=lambda: {"type": "text", "text": text})],
                           stop_reason="end_turn")


def _fake(monkeypatch, plan: dict):
    """plan: key -> list of outcomes (a CallError to raise, or text to answer), used one per call."""
    calls = []

    async def call(key, model, **kw):
        calls.append(key)
        out = plan[key].pop(0) if len(plan[key]) > 1 else plan[key][0]
        if isinstance(out, Exception):
            raise out
        return _reply(out)
    monkeypatch.setattr(llm, "_anthropic_create", call)
    monkeypatch.setattr(oai, "create", lambda pid, key, model, **kw: call(key, model, **kw))
    return calls


# ------------------------------------------------------------------ .env
def test_keys_are_appended_to_their_line_and_the_rest_of_the_file_is_kept(env):
    env.write_text("# my settings\nSTUDY=1\nANTHROPIC_API_KEY=" + ANT1 + "  # first\n")
    assert providers.keys("anthropic") == [ANT1]
    providers.add_key("anthropic", ANT2)
    text = env.read_text()
    assert "# my settings\nSTUDY=1\n" in text and f"ANTHROPIC_API_KEY={ANT1},{ANT2}" in text
    assert providers.keys("anthropic") == [ANT1, ANT2] and os.environ["ANTHROPIC_API_KEY"] == f"{ANT1},{ANT2}"
    assert "ANTHROPIC_API_KEYS" not in env.read_text()   # the line the file already had is the one that grows
    with pytest.raises(providers.SetupError, match="already saved"):
        providers.add_key("anthropic", ANT2)
    with pytest.raises(providers.SetupError, match="looks like a Groq key"):
        providers.add_key("anthropic", GROQ)
    providers.remove_key("anthropic", 0)
    assert providers.keys("anthropic") == [ANT2]
    providers.remove_key("anthropic", 0)
    assert "ANTHROPIC_API_KEY" not in env.read_text() and "STUDY=1" in env.read_text()


def test_a_new_env_file_is_made_readable_by_this_user_only(env):
    assert not env.exists()
    providers.add_key("groq", GROQ)
    assert env.read_text() == f"GROQ_API_KEYS={GROQ}\n"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600


def test_plural_and_singular_lines_are_both_read(env):
    env.write_text(f"GROQ_API_KEYS={GROQ}\nGROQ_API_KEY=gsk_{'h' * 40},{GROQ}\n")
    assert providers.keys("groq") == [GROQ, "gsk_" + "h" * 40]
    providers.add_key("groq", "gsk_" + "i" * 40)
    assert f"GROQ_API_KEYS={GROQ},gsk_{'i' * 40}" in env.read_text()
    assert providers.keys("groq") == [GROQ, "gsk_" + "i" * 40, "gsk_" + "h" * 40]
    providers.remove_key("groq", 2)
    assert f"GROQ_API_KEY={GROQ}\n" in env.read_text() and providers.keys("groq") == [GROQ, "gsk_" + "i" * 40]


def test_a_hand_edit_of_the_file_counts_at_once(env):
    env.write_text(f"GROQ_API_KEY={GROQ}\n")
    assert providers.keys("groq") == [GROQ]
    time.sleep(0.01)
    env.write_text(f"GROQ_API_KEY={GROQ},gsk_{'h' * 40}\n")
    os.utime(env, (time.time() + 5, time.time() + 5))
    assert len(providers.keys("groq")) == 2


def test_settings_add_checks_the_key_with_the_provider(env, monkeypatch):
    async def models(pid, key=None):
        if key == ANT1:
            return ["claude-sonnet-5-5"]
        raise CallError("auth", "the key was refused (401)")
    monkeypatch.setattr(llm, "list_models", models)
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    r = c.post("/api/ai/anthropic/keys", json={"key": ANT2}, headers=H)
    assert r.status_code == 409 and "didn't accept the key: the key was refused" in r.json()["error"]
    r = c.post("/api/ai/anthropic/keys", json={"key": ANT1}, headers=H)
    assert r.status_code == 200 and r.json()["models_found"] == ["claude-sonnet-5-5"]
    ant = next(p for p in r.json()["providers"] if p["id"] == "anthropic")
    assert ant["ready"] and ant["primary"] and ant["keys"][0]["hint"] == "…aaaa" and ANT1 not in r.text
    assert c.post("/api/ai/anthropic/keys", json={"key": "a b"}, headers=H).status_code == 409
    assert c.delete("/api/ai/anthropic/keys/0", headers=H).json()["primary"] is None


# ------------------------------------------------------------------ the walk
def test_the_next_key_answers_and_is_asked_first_next_time(env, monkeypatch):
    providers.add_key("anthropic", ANT1)
    providers.add_key("anthropic", ANT2)
    calls = _fake(monkeypatch, {ANT1: [CallError("billing", "no credit left")], ANT2: ["ok"]})
    r = asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    assert llm.text_of(r) == "ok" and r.provider == "anthropic" and calls == [ANT1, ANT2]
    calls.clear()
    asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    assert calls == [ANT2]   # the one that answered goes first; the one without credit rests
    assert providers.key_status("anthropic")[0]["resting"]


def test_a_busy_service_gets_two_retries_before_the_next_key(env, monkeypatch):
    providers.add_key("anthropic", ANT1)
    providers.add_key("anthropic", ANT2)
    busy = CallError("busy", "overloaded (503)")
    calls = _fake(monkeypatch, {ANT1: [busy, busy, busy, "late"], ANT2: ["ok"]})
    r = asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    assert calls == [ANT1, ANT1, ANT1, ANT2] and llm.text_of(r) == "ok"


def test_other_providers_are_left_alone_unless_the_user_allows_it(env, monkeypatch):
    providers.add_key("anthropic", ANT1)
    providers.add_key("groq", GROQ)
    providers.save_settings(models={"groq": {"main": "llama-x"}})
    _fake(monkeypatch, {ANT1: [CallError("auth", "the key was refused (401)")], GROQ: ["from groq"]})
    with pytest.raises(llm.Unavailable) as e:
        asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    msg = str(e.value)
    assert "No AI provider answered." in msg and "• Anthropic: key 1 (…aaaa): the key was refused (401)." in msg
    assert "Not tried: Groq, because moving on to other providers is off" in msg

    providers.save_settings(fallback=True)
    r = asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    assert llm.text_of(r) == "from groq" and r.provider == "groq"


def test_a_provider_without_a_model_says_so(env, monkeypatch):
    providers.save_settings(order=["local"], local_on=True)   # the local server has no default: it depends on the install
    with pytest.raises(llm.Unavailable, match="No model is chosen for Local model"):
        asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))


def test_nothing_set_up_asks_for_a_key(env):
    with pytest.raises(llm.NoKey, match="Settings → AI providers"):
        asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))


def test_the_order_decides_the_primary(env, monkeypatch):
    providers.add_key("anthropic", ANT1)
    providers.add_key("groq", GROQ)
    providers.save_settings(order=["groq", "anthropic"], models={"groq": {"main": "llama-x"}})
    calls = _fake(monkeypatch, {ANT1: ["a"], GROQ: ["g"]})
    asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))
    assert calls == [GROQ] and providers.primary() == "groq"


def test_a_reply_that_breaks_off_is_written_again_by_the_next_key(env, monkeypatch):
    providers.add_key("anthropic", ANT1)
    providers.add_key("anthropic", ANT2)

    async def stream(key, model, **kw):
        if key == ANT1:
            yield "text", "Half a sen"
            raise CallError("busy", "the stream broke", emitted=True)
        yield "text", "Whole answer."
        yield "final", _reply("Whole answer.")
    monkeypatch.setattr(llm, "_anthropic_stream", stream)

    async def run():
        return [ev async for ev in llm.stream(system="s", messages=[{"role": "user", "content": "hi"}])]
    evs = asyncio.run(run())
    kinds = [k for k, _ in evs]
    assert kinds == ["model", "text", "switch", "restart", "model", "text", "final"] or \
        kinds == ["model", "text", "restart", "switch", "model", "text", "final"]
    assert evs[-1][1].provider == "anthropic"


def test_oai_finish_reasons(env):
    assert oai.response("half a sente", [], None).stop_reason == "cut"
    assert oai.response("blocked", [], "content_filter").stop_reason == "cut"
    assert oai.response("done.", [], "stop").stop_reason == "end_turn"
    assert oai.response("long", [], "length").stop_reason == "max_tokens"


def test_error_kinds():
    assert oai.classify(429, '{"error":{"message":"You exceeded your current quota, check billing"}}')[0] == "quota"
    assert oai.classify(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}')[0] == "auth"
    assert oai.classify(402, '{"error":{"message":"Insufficient credits"}}')[0] == "billing"
    assert oai.classify(503, "")[0] == "busy"
    assert oai.classify(404, '{"error":{"message":"The model `x` does not exist"}}')[0] == "request"


def test_a_silent_stream_moves_on(env, monkeypatch):
    class Silent(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            time.sleep(3)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Silent)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    providers.save_settings(local_on=True, local_url=f"http://127.0.0.1:{srv.server_port}/v1",
                            models={"local": {"main": "tiny"}})
    monkeypatch.setattr(oai, "STALL_SEC", 0.05)   # × 4 for a local model

    async def run():
        return [ev async for ev in llm.stream(system="s", messages=[{"role": "user", "content": "hi"}], effort="low")]
    t = time.time()
    with pytest.raises(llm.Unavailable, match=r"Local model: no answer for 0 s"):
        asyncio.run(run())
    assert time.time() - t < 2.5
    srv.shutdown()


def test_a_local_server_that_is_off_is_named(env):
    providers.save_settings(local_on=True, local_url="http://127.0.0.1:9/v1", models={"local": {"main": "tiny"}})
    with pytest.raises(llm.Unavailable, match="the local server at http://127.0.0.1:9/v1 isn't answering"):
        asyncio.run(llm.create(system="s", messages=[{"role": "user", "content": "hi"}]))


def test_the_old_key_in_the_data_folder_moves_to_env(env):
    from app.config import DATA_DIR
    (DATA_DIR / "api-key").write_text(ANT1 + "\n")
    providers.migrate_legacy_key()
    assert providers.keys("anthropic") == [ANT1] and not (DATA_DIR / "api-key").exists()


def test_model_cards_hide_what_cannot_chat_and_keep_prices():
    from app import oai
    cards = oai.tidy("openrouter", [oai.card("openrouter", m) for m in [
        {"id": "google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)", "context_length": 262144, "created": 2,
         "pricing": {"prompt": "0", "completion": "0"}, "architecture": {"output_modalities": ["text"]}},
        {"id": "openai/gpt-6.2-sol", "name": "OpenAI: GPT-6.2 Sol", "context_length": 1050000, "created": 3,
         "pricing": {"prompt": "0.000002", "completion": "0.00001"}, "architecture": {"output_modalities": ["text"]}},
        {"id": "openai/gpt-6.2-sol:batch", "name": "batch", "created": 1, "pricing": {}},
        {"id": "x/painter", "name": "Painter", "created": 4, "architecture": {"output_modalities": ["image"]}},
    ]])
    by = {c["id"]: c for c in cards}
    assert [c["id"] for c in cards][0] == "x/painter"            # newest first
    assert by["google/gemma-4-31b-it:free"]["free"] and by["google/gemma-4-31b-it:free"]["chat"]
    assert by["openai/gpt-6.2-sol"]["price"] == "$2 / $10" and by["openai/gpt-6.2-sol"]["context"] == 1050000
    assert not by["openai/gpt-6.2-sol:batch"]["chat"] and not by["x/painter"]["chat"]
    g = oai.tidy("gemini", [oai.card("gemini", {"id": "models/gemini-3.5-flash", "display_name": "Gemini 3.5 Flash"}),
                            oai.card("gemini", {"id": "models/gemini-3.8-flash-tts"}),
                            oai.card("gemini", {"id": "models/gemini-embedding-2"})])
    assert [c["id"] for c in g if c["chat"]] == ["gemini-3.5-flash"]
    o = oai.tidy("openai", [oai.card("openai", {"id": i}) for i in ("gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5-pro", "whisper-1")])
    assert [c["id"] for c in o if c["chat"]] == ["gpt-5-mini"]


def test_models_come_from_code_not_env(env, monkeypatch):
    monkeypatch.setenv("CTU_MODEL", "should-not-count")
    monkeypatch.setenv("CTU_LLM", "gemini")
    s = providers.settings()
    assert s["models"]["anthropic"]["main"] == providers.PROVIDERS["anthropic"].main and s["order"][0] == "anthropic"


def test_an_empty_account_is_billing_not_a_rate_limit():
    from app import oai
    body = '{"error": {"message": "You have no credits remaining. Add credits to continue.", "code": "insufficient_quota"}}'
    assert oai.classify(429, body)[0] == "billing"
    assert oai.classify(429, '{"error": {"message": "Rate limit reached, try again in 2s"}}')[0] == "quota"
    assert oai.classify(429, '{"error": {"message": "You exceeded your current quota, please check your plan and billing details."}}')[0] == "quota"


def test_only_the_users_own_model_picks_are_stored(env):
    from app import db
    # what an older version wrote: every provider, empty where nothing was picked
    db.kv_set("ai_settings", {"models": {"openai": {"main": "gpt-4o", "chat": "gpt-4o"}, "groq": {"main": "", "chat": ""}}})
    m = providers.settings()["models"]
    assert m["groq"] == {"main": "openai/gpt-oss-120b", "chat": "openai/gpt-oss-20b"}       # the code's defaults
    assert m["openai"] == {"main": "gpt-4o", "chat": "gpt-4o"}                               # the user's pick stays
    assert m["openrouter"]["main"] == providers.PROVIDERS["openrouter"].main
    providers.save_settings(models={"groq": {"chat": ""}})          # coach: same as tests and plans
    assert providers.model("groq", "chat") == "openai/gpt-oss-120b"
    stored = db.kv_get("ai_settings")["models"]
    assert stored["groq"] == {"main": "", "chat": providers.SAME} and "openrouter" not in stored
    providers.save_settings(models={"groq": {"chat": "openai/gpt-oss-20b"}})   # back to the default: nothing stored
    assert "groq" not in db.kv_get("ai_settings")["models"]
