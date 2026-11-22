"""Khan content through Kolibri: grading, what the browser sees, practice and mastery, the in-app unit test."""
from __future__ import annotations

import json
import sqlite3
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import db, khan, main, perseus, state
from conftest import ROOT, set_now

H = {"x-ctu": "1"}
EX1, EX2, VID, UNIT = "e1" * 16, "e2" * 16, "d1" * 16, "c1" * 16
PKG1, PKG2, MP4, VTT = "a1" * 16, "a2" * 16, "b1" * 16, "b2" * 16


def numeric(k: int) -> dict:
    return {"question": {"content": f"What is $2+{k}$?\n\n[[☃ numeric-input 1]]", "images": {}, "widgets": {
        "numeric-input 1": {"type": "numeric-input", "graded": True, "options": {
            "answers": [{"value": k + 2, "status": "correct", "simplify": "required", "strict": False, "maxError": None,
                         "message": ""}], "coefficient": False}}}},
        "hints": [{"content": f"Add $2$ and ${k}$.", "widgets": {}}, {"content": f"$= {k + 2}$", "widgets": {}}]}


RADIO = {"question": {"content": "![graph](web+graphie:${☣ LOCALPATH}/images/abc123)\n\nPick one [[☃ radio 1]]", "widgets": {
    "radio 1": {"type": "radio", "options": {"randomize": True, "choices": [
        {"content": "$x$", "correct": False, "clue": "Not x."}, {"content": "$y$", "correct": True},
        {"content": "", "correct": False, "isNoneOfTheAbove": True}]}}}}, "hints": []}
GRAPH = {"question": {"content": "Plot it [[☃ grapher 1]]", "widgets": {"grapher 1": {"type": "grapher", "options": {}}}}, "hints": []}


def _zip(path, items: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("exercise.json", json.dumps({"all_assessment_items": list(items), "mastery_model": {"type": "m_of_n"}}))
        for k, v in items.items():
            z.writestr(f"{k}.json", json.dumps(v))
        z.writestr("images/abc123.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
        z.writestr("images/abc123-data.json", 'svgDataabc123({"range":[[0,10],[0,10]],"labels":[{"content":"5",'
                                              '"coordinates":[5,0],"alignment":"below","typesetAsMath":true}]});')


@pytest.fixture
def kolibri(seeded):
    """A miniature Khan channel: Math › Algebra 1 › Algebra foundations › one lesson with a video and two exercises."""
    home = ROOT / "kolibri"
    d = home / "content" / "databases"
    d.mkdir(parents=True)
    c = sqlite3.connect(d / f"{khan.CHANNEL}.sqlite3")
    c.execute("CREATE TABLE content_contentnode (id TEXT PRIMARY KEY, title TEXT, kind TEXT, duration INT, parent_id TEXT, "
              "description TEXT, lft INT, rght INT, tree_id INT, level INT, options TEXT)")
    c.execute("CREATE TABLE content_file (contentnode_id TEXT, local_file_id TEXT, extension TEXT, preset TEXT, "
              "lang_id TEXT, file_size INT, supplementary INT)")
    mth = '{"completion_criteria": {"threshold": {"m": 5, "n": 7}}}'
    nodes = [("r" * 32, "Khan", "topic", None, None, 1, 20, 0), ("m" * 32, "Math", "topic", None, "r" * 32, 2, 19, 1),
             ("c" * 32, "Algebra 1", "topic", None, "m" * 32, 3, 18, 2), (UNIT, "Algebra foundations", "topic", None, "c" * 32, 4, 17, 3),
             ("l" * 32, "Intro", "topic", None, UNIT, 5, 16, 4), (VID, "What is a variable?", "video", 197, "l" * 32, 6, 7, 5),
             (EX1, "Evaluating", "exercise", None, "l" * 32, 8, 9, 5), (EX2, "Graphs", "exercise", None, "l" * 32, 10, 11, 5)]
    for i, t, k, dur, par, lft, rght, lvl in nodes:
        c.execute("INSERT INTO content_contentnode VALUES(?,?,?,?,?,?,?,?,1,?,?)", (i, t, k, dur, par, "", lft, rght, lvl,
                                                                                    mth if k == "exercise" else "{}"))
    for row in [(VID, MP4, "mp4", "low_res_video", None), (VID, VTT, "vtt", "video_subtitle", "tr"),
                (EX1, PKG1, "perseus", "exercise", None), (EX2, PKG2, "perseus", "exercise", None)]:
        c.execute("INSERT INTO content_file VALUES(?,?,?,?,?,0,0)", row)
    c.commit()
    c.close()
    _zip(khan.stored(PKG1, "perseus"), {f"i{k}": numeric(k) for k in range(1, 9)})
    _zip(khan.stored(PKG2, "perseus"), {"r1": RADIO, "g1": GRAPH})
    for fid, ext in ((MP4, "mp4"), (VTT, "vtt")):
        khan.stored(fid, ext).parent.mkdir(parents=True, exist_ok=True)
        khan.stored(fid, ext).write_bytes(b"x")
    khan._conn = None
    khan._unit_nodes.clear()
    khan._package.cache_clear()
    yield home
    if khan._conn:
        khan._conn[1].close()
    khan._conn = None


# ------------------------------------------------------------------ grading
@pytest.mark.parametrize("given,want,kw,ok", [
    ("2(x+1)", "2x+2", {}, True), ("2x+3", "2x+2", {}, False),
    ("25>=3S+2M", r"3S+2M\le25", {}, True), ("3S+2M>=25", r"3S+2M\le25", {}, False), ("x<5", r"x\le5", {}, False),
    ("y-2x=1", "y=2x+1", {}, True), ("y-2x=1", "y=2x+1", {"form": True}, False),
    ("2x+3x", "5x", {"simplify": True}, False), ("x/2", r"\frac{1}{2}x", {}, True), ("2/3x", r"\dfrac{2}{3}x", {}, True),
    ("sqrt(x)", r"\sqrt{x}", {}, True), ("|x-2|", r"\left|x-2\right|", {}, True), ("pi r^2", r"\pi r^{2}", {}, True),
    ("__import__('os').system('true')", "x", {}, False), ("x.__class__", "x", {}, False),
])
def test_expression_equivalence(given, want, kw, ok):
    assert perseus.equivalent(given, want, **kw) is ok


@pytest.mark.parametrize("s,value,form", [("-3/4", -0.75, "proper"), ("1 1/2", 1.5, "mixed"), ("50%", 0.5, "percent"),
                                          ("1,000", 1000, "integer"), ("pi/2", 1.5707963, "pi"), (".5", 0.5, "decimal")])
def test_numbers(s, value, form):
    v, f, _ = perseus.parse_number(s)
    assert f == form and abs(v - value) < 1e-6


def test_unsimplified_fraction_is_not_accepted():
    w = {"answers": [{"value": 0.5, "status": "correct", "simplify": "required"}]}
    assert perseus._grade_numeric(w, "1/2")[0]
    ok, msg = perseus._grade_numeric(w, "2/4")
    assert not ok and "simplify" in msg


def test_browser_never_sees_answers():
    pub = perseus.public(RADIO["question"], "/api/khan/img/x", "seed")
    text = json.dumps(pub)
    assert '"correct"' not in text and "clue" not in text and "Not x" not in text
    assert pub["content"].startswith("![graph](/api/khan/img/x/abc123.svg)")
    assert pub["graphie"] == ["/api/khan/img/x/abc123.svg"]
    assert pub["widgets"]["radio 1"]["choices"][-1]["content"] == "None of the above"     # stays last when shuffled
    pub = perseus.public(numeric(3)["question"], "/b", "s")
    assert "5" not in json.dumps(pub["widgets"])


def test_radio_grading_and_clue():
    assert perseus.grade(RADIO, {"radio 1": [1]})["correct"]
    g = perseus.grade(RADIO, {"radio 1": [0]})
    assert not g["correct"] and g["widgets"]["radio 1"]["message"] == "Not x."
    assert not perseus.supported(GRAPH) and perseus.supported(RADIO)


# ------------------------------------------------------------------ outline, files, images
def test_outline(kolibri):
    o = khan.outline(0)
    les = o["lessons"][0]
    assert les["title"] == "Intro" and [i["kind"] for i in les["items"]] == ["video", "exercise", "exercise"]
    ex2 = les["items"][2]
    assert ex2["supported"] == 1 and ex2["total"] == 2 and ex2["kolibri"].endswith(f"/topics/c/{EX2}")
    assert o["counts"] | {} == {"videos": 1, "videos_ready": 1, "exercises": 2, "exercises_ready": 2, "mastered": 0, "video_min": 3}
    v = khan.video(VID)
    assert v["src"] == f"/api/khan/file/{MP4}.mp4" and v["subtitles"][0]["lang"] == "tr"


def test_not_set_up_is_a_clear_message(seeded):
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    r = c.get("/api/khan/unit/0")
    assert r.status_code == 409 and "setup-khan.sh" in r.json()["error"]
    assert c.get("/api/khan/status").json()["channel"] is False


def test_image_endpoints(kolibri):
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    r = c.get(f"/api/khan/img/{EX2}/abc123.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg") and "sandbox" in r.headers["content-security-policy"]
    lab = c.get(f"/api/khan/graphie/{EX2}/abc123").json()["labels"][0]
    assert lab["left"] == 50 and lab["top"] == 100 and lab["align"] == "below"
    for bad in (f"/api/khan/img/{EX2}/..%2F..%2Fetc%2Fpasswd", f"/api/khan/img/{EX2}/....etcpasswd",
                "/api/khan/file/..%2F..%2Fx.mp4", "/api/khan/file/abc.mp4"):
        r = c.get(bad)
        assert "root:" not in r.text and not r.headers["content-type"].startswith(("image/", "video/"))
    assert c.get(f"/api/khan/file/{MP4}.mp4").status_code == 200


# ------------------------------------------------------------------ practice
def _answer(item_id: str, right: bool) -> dict:
    k = int(item_id[1:])
    return {"numeric-input 1": str(k + 2 if right else k + 3)}


def test_practice_first_try_counts_and_mastery(kolibri):
    for n in range(5):
        q = khan.next_item(EX1)
        assert q["question"]["widgets"]["numeric-input 1"].get("answers") is None
        r = khan.check(EX1, q["item_id"], _answer(q["item_id"], True))
        assert r["correct"]
    assert khan._progress(EX1)["mastered"]
    assert db.q1("SELECT unit_idx FROM khan_mastery WHERE exercise_id=?", (EX1,))["unit_idx"] == 0


def test_wrong_then_right_counts_as_wrong_and_hint_too(kolibri):
    q = khan.next_item(EX1)
    assert not khan.check(EX1, q["item_id"], _answer(q["item_id"], False))["correct"]
    assert khan.next_item(EX1)["item_id"] == q["item_id"]           # same question until it's right
    assert khan.check(EX1, q["item_id"], _answer(q["item_id"], True))["correct"]
    q2 = khan.next_item(EX1)
    assert q2["item_id"] != q["item_id"]
    assert len(khan.hint(EX1, q2["item_id"])["hints"]) == 1
    khan.check(EX1, q2["item_id"], _answer(q2["item_id"], True))
    assert [r["correct"] for r in db.q("SELECT correct FROM khan_attempts ORDER BY id")] == [0, 0]
    with pytest.raises(state.Refused):
        khan.check(EX1, q2["item_id"], {})                           # no longer the current question


def test_reveal_counts_wrong_and_shows_solution(kolibri):
    q = khan.next_item(EX1)
    r = khan.reveal(EX1, q["item_id"])
    assert len(r["hints"]) == 2 and r["solution"]["numeric-input 1"].startswith("$")
    assert db.q1("SELECT correct, hinted FROM khan_attempts") == {"correct": 0, "hinted": 1}


# ------------------------------------------------------------------ unit test
def _test_task() -> dict:
    return db.q1("SELECT * FROM tasks WHERE date='2026-11-23' AND kind='khan_test'")


def test_unit_test_grades_and_records_the_score(kolibri):
    set_now("2026-11-23T10:05")
    tid = khan.start_test(_test_task()["id"])
    assert khan.start_test(_test_task()["id"]) == tid                   # resumes, doesn't make another
    t = khan.get_test(tid)
    assert len(t["questions"]) == 9 and "results" in t and t["results"] is None   # 8 numeric + 1 radio, graph left out
    answers = {}
    for q in t["questions"]:
        ex, item = q["key"].split(":")
        answers[q["key"]] = {"radio 1": [1]} if item == "r1" else _answer(item, True)
    first = next(iter(answers))
    answers[first] = {"numeric-input 1": "999"}                          # one wrong
    r = khan.submit_test(tid, answers)
    assert r["test"]["score"] == round(100 * 8 / 9, 1) and r["passed"] is False
    assert r["test"]["results"][first]["solution"]
    s = db.q1("SELECT * FROM scores WHERE kind='khan_unit'")
    assert s["value"] == round(100 * 8 / 9, 1) and s["item"] == "Algebra 1 · Algebra foundations"
    assert "| Algebra foundations | %88.9 | tekrar |" in (ROOT / "repo" / "math" / "log.md").read_text()
    assert (ROOT / "COACH.md").read_text().count("Khan ünite testi artık uygulamanın içinde") == 1
    with pytest.raises(state.Refused):
        khan.submit_test(tid, answers)


def test_passing_test_moves_the_cursor(kolibri):
    set_now("2026-11-23T10:05")
    tid = khan.start_test(_test_task()["id"])
    answers = {q["key"]: ({"radio 1": [1]} if q["key"].endswith("r1") else _answer(q["key"].split(":")[1], True))
               for q in khan.get_test(tid)["questions"]}
    assert khan.submit_test(tid, answers)["passed"]
    assert db.kv_get("cursor")["khan_unit"] == 1


def test_unit_test_waits_for_downloads(kolibri):
    khan.stored(PKG2, "perseus").unlink()
    khan._package.cache_clear()
    set_now("2026-11-23T10:05")
    with pytest.raises(khan.Unavailable, match="still downloading"):
        khan.start_test(_test_task()["id"])


def test_khan_api_round_trip(kolibri):
    c = TestClient(main.app, base_url="http://127.0.0.1:8723")
    q = c.get(f"/api/khan/exercise/{EX1}").json()
    assert c.post(f"/api/khan/exercise/{EX1}/check", json={"item_id": q["item_id"], "answers": {}}).status_code == 403  # guard
    r = c.post(f"/api/khan/exercise/{EX1}/check", headers=H, json={"item_id": q["item_id"], "answers": _answer(q["item_id"], True)})
    assert r.json()["correct"]


def test_math_ii_task_can_start_a_unit_test_but_lessons_task_cannot(kolibri):
    set_now("2026-11-23T15:05")
    lessons = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' AND kind='khan_study' AND meta NOT LIKE '%score_kind%'")
    with pytest.raises(state.Refused):
        khan.start_test(lessons["id"])
    db.ex("UPDATE tasks SET meta=? WHERE date='2026-11-23' AND title LIKE 'Math II%'", (json.dumps({"unit_idx": 0, "score_kind": "khan_unit"}),))
    math2 = db.q1("SELECT id FROM tasks WHERE date='2026-11-23' AND title LIKE 'Math II%'")
    assert khan.start_test(math2["id"]) > 0


def test_old_task_texts_are_rewritten_on_open_days():
    import sqlite3 as sq
    c = sq.connect(":memory:")
    c.execute("CREATE TABLE days(date TEXT, status TEXT)")
    c.execute("CREATE TABLE tasks(date TEXT, kind TEXT, detail TEXT)")
    c.executemany("INSERT INTO days VALUES(?,?)", [("2026-11-22", "closed"), ("2026-11-23", "planned")])
    old = "Puanı buraya gir; `math/log.md`'ye otomatik yazılır."
    c.executemany("INSERT INTO tasks VALUES(?,?,?)", [("2026-11-22", "khan_test", old), ("2026-11-23", "khan_test", old)])
    db._m7_khan_texts(c)
    assert [r[0] for r in c.execute("SELECT detail FROM tasks ORDER BY date")] == [old, "Puan kaydedilir ve `math/log.md`'ye otomatik yazılır."]
