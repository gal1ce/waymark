"""The notebook (pages, images) and XP derived from recorded work."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import db, main, notes, xp

H = {"x-ctu": "1"}
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


@pytest.fixture
def client(seeded):
    return TestClient(main.app, base_url="http://127.0.0.1:8723")


def test_page_lifecycle(client):
    p = client.post("/api/notes", json={"title": "Limits", "kind": "doc"}, headers=H).json()
    assert p["kind"] == "doc" and p["body"]["blocks"][0]["type"] == "text"
    body = {"blocks": [{"id": "a", "type": "text", "md": "# Squeeze\n$\\lim_{x\\to 0} \\frac{\\sin x}{x} = 1$"},
                       {"id": "b", "type": "graph", "fns": [{"expr": "sin(x)/x"}]},
                       {"id": "c", "type": "canvas", "height": 400,
                        "items": [{"id": "i1", "type": "text", "x": 0, "y": 0, "w": 200, "h": 80, "md": "inside a canvas"}],
                        "arrows": [], "strokes": []}]}
    r = client.put(f"/api/notes/{p['id']}", json={"body": body, "title": "Squeeze theorem"}, headers=H)
    assert r.status_code == 200 and r.json()["title"] == "Squeeze theorem"
    got = client.get(f"/api/notes/{p['id']}").json()
    assert got["body"] == body
    listed = client.get("/api/notes").json()["pages"]
    assert listed[0]["id"] == p["id"] and "Squeeze" in listed[0]["preview"] and "inside a canvas" in listed[0]["preview"]
    assert "body" not in listed[0]
    assert client.delete(f"/api/notes/{p['id']}", headers=H).status_code == 200
    assert client.get(f"/api/notes/{p['id']}").status_code == 409


def test_canvas_page_and_bad_input(client):
    p = client.post("/api/notes", json={"title": "", "kind": "canvas"}, headers=H).json()
    assert p["title"] == "Untitled" and p["body"] == {"canvas": {"items": [], "arrows": [], "strokes": []}}
    assert client.post("/api/notes", json={"kind": "spreadsheet"}, headers=H).status_code == 409
    assert client.put(f"/api/notes/{p['id']}", json={"body": {"nope": 1}}, headers=H).status_code == 409
    # writes need the app's header like everything else
    assert client.post("/api/notes", json={"kind": "doc"}).status_code == 403


def test_images_are_stored_next_to_the_database(client):
    r = client.post("/api/notes-assets", content=PNG, headers={**H, "content-type": "image/png"})
    name = r.json()["name"]
    assert (notes.assets_dir() / name).read_bytes() == PNG
    img = client.get(f"/api/notes-assets/{name}")
    assert img.status_code == 200 and img.content == PNG and img.headers["content-type"] == "image/png"
    assert client.post("/api/notes-assets", content=b"<svg/>", headers={**H, "content-type": "image/svg+xml"}).status_code == 409
    for bad in ("..%2F..%2Fctu.db", "abc.png", name.replace(".png", ".svg")):
        r = client.get(f"/api/notes-assets/{bad}")
        assert not r.headers["content-type"].startswith("image/")


def test_xp_comes_from_recorded_work(seeded):
    assert xp.level_for(0) == {"level": 1, "into": 0, "span": 100}
    assert xp.level_for(100) == {"level": 2, "into": 0, "span": 200}
    assert xp.level_for(350)["level"] == 3
    base = xp.summary()["total"]
    t = db.q1("SELECT id FROM tasks WHERE status<>'done' ORDER BY id LIMIT 1")
    db.ex("UPDATE tasks SET status='done', done_at=? WHERE id=?", (db.ts(), t["id"]))
    db.ex("INSERT INTO khan_attempts(ts,date,exercise_id,item_id,mode,correct,hinted) VALUES(?,?,?,?,?,?,?)",
          (db.ts(), db.ts()[:10], "e", "i", "practice", 1, 0))
    db.ex("INSERT INTO khan_attempts(ts,date,exercise_id,item_id,mode,correct,hinted) VALUES(?,?,?,?,?,?,?)",
          (db.ts(), db.ts()[:10], "e", "j", "practice", 1, 1))
    s = xp.summary()
    assert s["total"] == base + xp.TASK + xp.KHAN_FIRST_TRY + xp.KHAN_COUNTED
    assert s["today"] >= xp.TASK + xp.KHAN_FIRST_TRY + xp.KHAN_COUNTED
    assert len(s["week"]) == 7 and s["recent"][0]["xp"] in (xp.TASK, xp.KHAN_FIRST_TRY, xp.KHAN_COUNTED)


def test_blank_pages_left_behind_are_cleared(client):
    blank = client.post("/api/notes", json={"title": "", "kind": "doc"}, headers=H).json()
    kept = client.post("/api/notes", json={"title": "", "kind": "canvas"}, headers=H).json()
    client.put(f"/api/notes/{kept['id']}", json={"body": {"canvas": {"items": [], "arrows": [], "strokes": [
        {"id": "s", "pts": [0, 0, 5, 5], "color": "ink", "size": 4}]}}}, headers=H)
    ids = [p["id"] for p in client.get("/api/notes").json()["pages"]]
    assert blank["id"] in ids                      # just made: maybe still being opened
    db.ex("UPDATE notes_pages SET updated_at='2000-01-01T00:00:00'")
    ids = [p["id"] for p in client.get("/api/notes").json()["pages"]]
    assert blank["id"] not in ids and kept["id"] in ids


def test_notices_history(client):
    from app import notices, state
    assert client.get("/api/notices").json() == {"notices": [], "unread": 0}
    state.add_stuck("test", "Wrong answer · C · pointers", dedupe_min=0)
    state.add_stuck("test", "Wrong answer · C · arrays", dedupe_min=0)
    got = client.get("/api/notices").json()
    assert got["unread"] == 1 and got["notices"][0]["title"] == "2 new sticking points"
    assert len(got["notices"][0]["items"]) == 2
    c = client.post("/api/notices", json={"title": "The page wasn't saved", "tone": "err"}, headers=H).json()
    assert c["source"] == "client" and c["tone"] == "err"
    assert client.post("/api/notices", json={"title": "  "}, headers=H).status_code == 409
    client.post(f"/api/notices/{c['id']}/read", headers=H)
    assert client.get("/api/notices").json()["unread"] == 1
    client.post("/api/notices/read", headers=H)
    assert client.get("/api/notices").json()["unread"] == 0
    client.delete(f"/api/notices/{c['id']}", headers=H)
    assert [n["id"] for n in client.get("/api/notices").json()["notices"]] == [got["notices"][0]["id"]]
    client.delete("/api/notices", headers=H)
    assert client.get("/api/notices").json()["notices"] == []
    notices.add("close", "Day 2026-11-23 closed", tone="ok")
    assert client.get("/api/notices").json()["notices"][0]["tone"] == "ok"


def test_repeated_notice_is_folded(client):
    h = {"X-CTU": "1"}
    for _ in range(3):
        assert client.post("/api/notices", json={"title": "Server unreachable", "tone": "err"}, headers=h).status_code == 200
    d = client.get("/api/notices").json()
    assert [n["title"] for n in d["notices"]].count("Server unreachable") == 1
    assert d["unread"] == 1


def test_coach_avatar_upload_replace_and_clear(client):
    from app import coach
    assert client.get("/api/meta").json()["coach_avatar"] is None
    r = client.post("/api/coach/avatar", content=PNG, headers={**H, "content-type": "image/png"})
    url = r.json()["coach_avatar"]
    assert url and client.get("/api/meta").json()["coach_avatar"] == url
    first = coach.avatar()
    img = client.get(url)
    assert img.status_code == 200 and img.content == PNG
    # a new picture replaces the old file and gets a new address
    url2 = client.post("/api/coach/avatar", content=PNG, headers={**H, "content-type": "image/png"}).json()["coach_avatar"]
    assert url2 != url and not (coach.avatar_dir() / first).exists()
    assert client.get(url).status_code == 409
    assert client.post("/api/coach/avatar", content=b"<svg/>", headers={**H, "content-type": "image/svg+xml"}).status_code == 409
    assert client.post("/api/coach/avatar", content=PNG, headers={"content-type": "image/png"}).status_code == 403
    assert client.delete("/api/coach/avatar", headers=H).json() == {"coach_avatar": None}
    assert client.get("/api/meta").json()["coach_avatar"] is None and not any(coach.avatar_dir().iterdir())
