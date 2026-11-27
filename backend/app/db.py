"""SQLite storage. One file, small tables, JSON columns where shape varies."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH, now

log = logging.getLogger("ctu.db")
_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_tx_depth = 0
_allow_default = False


def allow_default_db() -> None:
    """Called by the server at startup. Anything else (a script, a `python -c` import) must name the
    database with CTU_DB, so poking at the code never opens the real data by accident."""
    global _allow_default
    _allow_default = True

SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY,
    week INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'study',          -- study | off
    version TEXT NOT NULL DEFAULT 'reference',   -- reference | adapted
    status TEXT NOT NULL DEFAULT 'planned',      -- planned | closed
    title TEXT,
    adapt_note TEXT,
    summary TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    ord INTEGER NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    kind TEXT NOT NULL,      -- math | eng | c | kintsugi | break | test
    title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    block_id INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,      -- read | exercise | khan_test | khan_study | write | kintsugi_read | review | other
    learning INTEGER NOT NULL DEFAULT 1,
    resources TEXT NOT NULL DEFAULT '[]',
    files TEXT NOT NULL DEFAULT '[]',
    est_min INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | done
    spent_sec INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    first_started_at TEXT,
    done_at TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    task_id INTEGER,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS stuck (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    task_id INTEGER,
    source TEXT NOT NULL,   -- idle | compile | overtime | wrong_answer | low_score | wrong_check | boredom | manual | agent
    summary TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    task_id INTEGER,
    kind TEXT NOT NULL,     -- khan_unit | eod_test | c_quiz | ...
    item TEXT NOT NULL,
    value REAL NOT NULL,
    max REAL NOT NULL,
    threshold REAL,
    passed INTEGER,
    note TEXT
);
CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'eod',       -- eod | c_quiz
    task_id INTEGER,
    status TEXT NOT NULL DEFAULT 'ready',   -- generating | ready | in_progress | submitted | failed
    source TEXT NOT NULL DEFAULT 'agent',   -- agent | fallback
    questions TEXT NOT NULL DEFAULT '[]',
    answers TEXT NOT NULL DEFAULT '{}',
    results TEXT NOT NULL DEFAULT '[]',
    score REAL,
    max REAL,
    time_limit_min INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL,
    started_at TEXT,
    submitted_at TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    role TEXT NOT NULL,          -- user | assistant | system
    content TEXT NOT NULL,       -- JSON: what is replayed to the API
    display TEXT NOT NULL DEFAULT '',
    task_id INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS convos (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,          -- study day the conversation belongs to
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coach_memory (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_stuck_date ON stuck(date);
"""


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        if not os.environ.get("CTU_DB") and not _allow_default:
            raise RuntimeError(f"Refusing to open the real database ({DB_PATH}) outside the server. "
                               f"Set CTU_DB to a copy, or CTU_DB={DB_PATH} if you really mean the real one.")
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA busy_timeout=5000")
        _conn.executescript(SCHEMA)
        _migrate(_conn)
    return _conn


@contextlib.contextmanager
def tx() -> Iterator[None]:
    """All statements inside run as one transaction: either all of them land or none.
    Holds the connection lock for the whole block, so never `await` inside it."""
    global _tx_depth
    with _lock:
        c = conn()
        if _tx_depth == 0:
            c.execute("BEGIN IMMEDIATE")
        _tx_depth += 1
        ok = False
        try:
            yield
            ok = True
        finally:
            _tx_depth -= 1
            if _tx_depth == 0:
                c.execute("COMMIT" if ok else "ROLLBACK")


def checkpoint() -> None:
    """Fold the WAL into the main file, so ctu.db on its own holds everything."""
    with _lock:
        if _conn is not None and _tx_depth == 0:
            _conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")


BACKUP_KEEP = 21


def backup_dir() -> Path:
    return DB_PATH.parent / "backups"


def backup(tag: str) -> Path:
    """A complete, consistent copy (VACUUM INTO includes what is still in the WAL). Keeps the newest BACKUP_KEEP."""
    d = backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"ctu-{tag}.db"
    tmp = out.with_suffix(".db.tmp")
    with _lock:
        if _tx_depth:
            raise RuntimeError("backup inside a transaction")
        tmp.unlink(missing_ok=True)
        conn().execute("VACUUM INTO ?", (str(tmp),))
    os.replace(tmp, out)
    olds = sorted(d.glob("ctu-*.db"), key=lambda p: p.stat().st_mtime)
    for old in olds[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    kv_set("last_backup", {"path": str(out), "ts": ts()})
    return out


def title_from(text: str) -> str:
    """Conversation title from a user message: skip the page tag and quoted page text."""
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith(">") or (line.startswith("[from the ") and line.endswith("]")):
            continue
        return line if len(line) <= 48 else line[:47].rstrip() + "…"
    return ""


def _m1_convos(c: sqlite3.Connection) -> None:
    """Chat rows belong to a conversation. Each existing day's chat becomes one conversation."""
    cols = {r[1] for r in c.execute("PRAGMA table_info(chat)")}
    if "convo_id" not in cols:
        c.execute("ALTER TABLE chat ADD COLUMN convo_id INTEGER")
    for (d,) in c.execute("SELECT DISTINCT date FROM chat WHERE convo_id IS NULL ORDER BY date").fetchall():
        lo, hi = c.execute("SELECT MIN(ts), MAX(ts) FROM chat WHERE date=? AND convo_id IS NULL", (d,)).fetchone()
        first = c.execute("SELECT display FROM chat WHERE date=? AND convo_id IS NULL AND role='user' AND display<>'' "
                          "ORDER BY id LIMIT 1", (d,)).fetchone()
        cid = c.execute("INSERT INTO convos(date,title,created_at,updated_at) VALUES(?,?,?,?)",
                        (d, title_from(first[0]) if first else "", lo, hi)).lastrowid
        c.execute("UPDATE chat SET convo_id=? WHERE date=? AND convo_id IS NULL", (cid, d))
    c.execute("CREATE INDEX IF NOT EXISTS idx_chat_convo ON chat(convo_id)")


def _m2_test_cancel(c: sqlite3.Connection) -> None:
    """A test can be cancelled; it's then 'submitted' with every question counted unanswered."""
    if "cancelled" not in {r[1] for r in c.execute("PRAGMA table_info(tests)")}:
        c.execute("ALTER TABLE tests ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0")


def _m3_test_pause(c: sqlite3.Connection) -> None:
    """Leaving a test pauses it; used_sec is the test time spent before the current run."""
    if "used_sec" not in {r[1] for r in c.execute("PRAGMA table_info(tests)")}:
        c.execute("ALTER TABLE tests ADD COLUMN used_sec INTEGER NOT NULL DEFAULT 0")


def _m4_seed_refresh(c: sqlite3.Connection) -> None:
    """Seed data copied into kv at first run follows the current seed (the Turkish fallback test became English)."""
    from .seed import FALLBACK_TESTS
    if c.execute("SELECT 1 FROM kv WHERE key='fallback_tests'").fetchone():
        c.execute("UPDATE kv SET value=? WHERE key='fallback_tests'", (json.dumps(FALLBACK_TESTS, ensure_ascii=False),))


def _m5_indexes(c: sqlite3.Connection) -> None:
    c.execute("CREATE INDEX IF NOT EXISTS idx_tests_status ON tests(status)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id)")


def _m6_khan(c: sqlite3.Connection) -> None:
    """Khan exercises and unit tests inside the app (Kolibri content). One statement at a time:
    executescript would commit the migration's transaction halfway."""
    for sql in (
        "CREATE TABLE IF NOT EXISTS khan_attempts (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, date TEXT NOT NULL, "
        "exercise_id TEXT NOT NULL, item_id TEXT NOT NULL, mode TEXT NOT NULL, test_id INTEGER, correct INTEGER NOT NULL, "
        "hinted INTEGER NOT NULL DEFAULT 0, answer TEXT)",
        "CREATE INDEX IF NOT EXISTS idx_khan_attempts_ex ON khan_attempts(exercise_id, mode)",
        "CREATE TABLE IF NOT EXISTS khan_mastery (exercise_id TEXT PRIMARY KEY, unit_idx INTEGER, mastered_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS khan_tests (id INTEGER PRIMARY KEY, date TEXT NOT NULL, task_id INTEGER, "
        "unit_idx INTEGER NOT NULL, status TEXT NOT NULL, items TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}', "
        "results TEXT, created_at TEXT NOT NULL, submitted_at TEXT, score REAL)",
    ):
        c.execute(sql)


_KHAN_TEXTS = [
    ("Take the **Unit test** at the bottom of the unit page (click the unit name, not the Start button).",
     "Start the **unit test** here: Khan's own questions (through Kolibri), graded by the app."),
    ("Enter the score here; it's written to `math/log.md` automatically.",
     "The score is saved and written to `math/log.md` automatically."),
    ("work each exercise on Khan until **Proficient**",
     "work each exercise here until it's **mastered** (5 of the last 7 right, Khan's rule)"),
    ("Each exercise on Khan until Proficient.", "Each exercise until mastered (5 of the last 7 right)."),
    ("Watch the unit's lessons in order", "Watch the unit's videos in order"),
    # days planned before the app switched to English
    ("Ünite sayfasının en altındaki **Unit test**'i çöz (Start butonuna değil, ünite adına tıkla).",
     "**Unit test**'i burada çöz: Khan'ın kendi soruları (Kolibri üzerinden), uygulama puanlar."),
    ("Puanı buraya gir; `math/log.md`'ye otomatik yazılır.", "Puan kaydedilir ve `math/log.md`'ye otomatik yazılır."),
    ("her alıştırmayı Khan'da **Proficient** olana kadar çöz.",
     "her alıştırmayı burada **ustalaşana** kadar çöz (son 7 ilk denemeden 5'i doğru, Khan'ın kuralı)."),
]


def _m7_khan_texts(c: sqlite3.Connection) -> None:
    """Days that aren't closed yet: Khan task texts now point at the in-app videos, exercises and test."""
    for old, new in _KHAN_TEXTS:
        c.execute("UPDATE tasks SET detail=REPLACE(detail, ?, ?) WHERE kind IN ('khan_test','khan_study') "
                  "AND date IN (SELECT date FROM days WHERE status<>'closed')", (old, new))


def _m8_notes(c: sqlite3.Connection) -> None:
    """The personal notebook: pages of text, LaTeX, graphs, images and drawings (images live next to the DB)."""
    c.execute("CREATE TABLE IF NOT EXISTS notes_pages (id INTEGER PRIMARY KEY, title TEXT NOT NULL, "
              "kind TEXT NOT NULL DEFAULT 'doc', body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")


def _m9_notices(c: sqlite3.Connection) -> None:
    """The notification history (the bell in the top bar)."""
    c.execute("CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, "
              "tone TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, "
              "source TEXT NOT NULL DEFAULT 'app', items TEXT, read INTEGER NOT NULL DEFAULT 0)")


def _m10_profile(c: sqlite3.Connection) -> None:
    """The local account: one row, the person this install belongs to. An install that already has days is the CTU
    plan's user, who has used their GitHub profile all along; a new install is asked about GitHub."""
    c.execute("CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL DEFAULT '', "
              "photo TEXT, preset TEXT NOT NULL DEFAULT 'ctu', github TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    if not c.execute("SELECT 1 FROM profile").fetchone():
        old = c.execute("SELECT 1 FROM days LIMIT 1").fetchone()
        t = ts()
        c.execute("INSERT INTO profile (id, preset, github, created_at, updated_at) VALUES (1, 'ctu', ?, ?, ?)",
                  ("on" if old else None, t, t))


def _m11_plan(c: sqlite3.Connection) -> None:
    """Which plan an install runs. One with days in it is the CTU plan's user and stays on it; a new one has no plan
    until onboarding ('none'). plan_log is the coach log of a custom plan: decisions and weekly notes, kept here
    and written out to PLAN.md (the CTU plan keeps writing its log into COACH.md, as approved)."""
    if not c.execute("SELECT 1 FROM days LIMIT 1").fetchone():
        c.execute("UPDATE profile SET preset='none' WHERE id=1 AND preset='ctu'")
    c.execute("CREATE TABLE IF NOT EXISTS plan_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, heading TEXT, "
              "text TEXT NOT NULL)")


# Append only: a database at user_version N has run MIGRATIONS[:N]. Each step must also be safe on a
# database that already has the change (databases from before versioning start at 0).
def _m12_note_topic(c: sqlite3.Connection) -> None:
    """A notebook page can name the topic it is about (a unit, a test topic), so the day page and Progress link to it."""
    _m8_notes(c)   # a database marked newer than v8 may still lack the table (one restored from an odd backup)
    if "topic" not in {r[1] for r in c.execute("PRAGMA table_info(notes_pages)")}:
        c.execute("ALTER TABLE notes_pages ADD COLUMN topic TEXT NOT NULL DEFAULT ''")


_BLOCK_EN = {"Matematik": "Math", "Matematik II": "Math II", "İngilizce": "English", "Öğle arası": "Lunch", "Mola": "Break",
             "Gün sonu testi + kapanış": "End-of-day test + close"}


def _m13_english_seed(c: sqlite3.Connection) -> None:
    """The CTU plan's first three days were stored while the app still wrote Turkish: their task texts follow the
    current (English) seed. Only the text changes (title, detail, resource labels); status, time spent and meta stay.
    A task is rewritten only where it still sits where the seed put it (same block, place and kind, not carried over)."""
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "profile" not in tables or not c.execute("SELECT 1 FROM profile WHERE preset='ctu'").fetchone():
        return
    from .seed import monday, tuesday, wednesday
    for ds, make in (("2026-11-23", monday), ("2026-11-24", tuesday), ("2026-11-25", wednesday)):
        day = c.execute("SELECT status FROM days WHERE date=?", (ds,)).fetchone()
        if not day or day[0] == "closed":
            continue
        plan, seen = make(), {}
        for bid, kind in c.execute("SELECT id, kind FROM blocks WHERE date=? ORDER BY ord", (ds,)).fetchall():
            n = seen[kind] = seen.get(kind, 0) + 1
            for i, t in enumerate(plan.get(kind if n == 1 else f"{kind}{n}", [])):
                c.execute("UPDATE tasks SET title=?, detail=?, resources=? WHERE block_id=? AND ord=? AND kind=? "
                          "AND meta NOT LIKE '%carried_from%'",
                          (t["title"], t.get("detail", ""), json.dumps(t.get("resources", []), ensure_ascii=False), bid, i, t["kind"]))
    for old, new in _BLOCK_EN.items():
        c.execute("UPDATE blocks SET title=? WHERE title=? AND date IN (SELECT date FROM days WHERE status<>'closed')", (new, old))


def _m14_skip_passed_study(c: sqlite3.Connection) -> None:
    """A passed unit test now ticks off that unit's "lessons + exercises" task (state._skip_unit_study); do the same
    for tests passed before this existed, on days that aren't closed."""
    rows = c.execute("SELECT t.id, t.date, t.meta, (SELECT s.value FROM scores s WHERE s.task_id=t.id ORDER BY s.id DESC LIMIT 1), "
                     "(SELECT s.passed FROM scores s WHERE s.task_id=t.id ORDER BY s.id DESC LIMIT 1) FROM tasks t "
                     "WHERE t.kind='khan_test' AND t.date IN (SELECT date FROM days WHERE status<>'closed')").fetchall()
    for _tid, ds, meta, value, passed in rows:
        if not passed:
            continue
        idx = int(json.loads(meta or "{}").get("unit_idx", 0))
        for sid, smeta in c.execute("SELECT id, meta FROM tasks WHERE date=? AND kind='khan_study' AND status<>'done'", (ds,)).fetchall():
            m = json.loads(smeta or "{}")
            if int(m.get("unit_idx", -1)) != idx or m.get("score_kind") == "khan_unit":
                continue
            m["skipped"] = {"reason": "unit_passed", "percent": value}
            c.execute("UPDATE tasks SET status='done', started_at=NULL, done_at=?, meta=? WHERE id=?",
                      (ts(), json.dumps(m, ensure_ascii=False), sid))


def _m15_chat_meta(c: sqlite3.Connection) -> None:
    """A coach reply keeps what it did on the way (its tool steps) and the replies it suggested next."""
    if "meta" not in {r[1] for r in c.execute("PRAGMA table_info(chat)")}:
        c.execute("ALTER TABLE chat ADD COLUMN meta TEXT NOT NULL DEFAULT ''")


MIGRATIONS = [_m1_convos, _m2_test_cancel, _m3_test_pause, _m4_seed_refresh, _m5_indexes, _m6_khan, _m7_khan_texts, _m8_notes, _m9_notices, _m10_profile,
              _m11_plan, _m12_note_topic, _m13_english_seed, _m14_skip_passed_study, _m15_chat_meta]


def _migrate(c: sqlite3.Connection) -> None:
    v = c.execute("PRAGMA user_version").fetchone()[0]
    if v < len(MIGRATIONS) and c.execute("SELECT 1 FROM days LIMIT 1").fetchone():
        # an existing database is about to change shape: keep a copy of it as it was
        d = backup_dir()
        d.mkdir(parents=True, exist_ok=True)
        out = d / f"ctu-before-v{len(MIGRATIONS)}-{now().strftime('%Y-%m-%dT%H%M%S')}.db"
        c.execute("VACUUM INTO ?", (str(out),))
        log.info("backed up the database before migrating: %s", out)
    for n, step in enumerate(MIGRATIONS, 1):
        if v >= n:
            continue
        c.execute("BEGIN IMMEDIATE")
        try:
            step(c)
            c.execute(f"PRAGMA user_version={n}")
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise
        log.info("database migrated to v%d (%s)", n, step.__name__)


def schema_version() -> int:
    return q1("PRAGMA user_version")["user_version"]


def q(sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def q1(sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    rows = q(sql, params)
    return rows[0] if rows else None


def ex(sql: str, params: tuple | list = ()) -> int:
    with _lock:
        cur = conn().execute(sql, params)
        return cur.lastrowid or 0


def ts() -> str:
    return now().isoformat(timespec="seconds")


def kv_get(key: str, default: Any = None) -> Any:
    row = q1("SELECT value FROM kv WHERE key=?", (key,))
    return json.loads(row["value"]) if row else default


def kv_set(key: str, value: Any) -> None:
    ex("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, json.dumps(value, ensure_ascii=False)))


JSON_COLS = {"resources", "files", "meta", "data", "questions", "answers", "results", "content"}


def decode(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    out = dict(row)
    for k in JSON_COLS & out.keys():
        if isinstance(out[k], str):
            try:
                out[k] = json.loads(out[k])
            except json.JSONDecodeError:
                pass
    return out
