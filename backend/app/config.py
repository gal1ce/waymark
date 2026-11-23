"""Paths, model and clock. Everything that differs per machine lives here."""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

from . import profile
from .paths import APP_ROOT, FROZEN, HOME, LEGACY_DB, data_dir_for, env_file  # noqa: F401 (re-exported)

load_dotenv(env_file())

STUDY_REPO = Path(os.environ.get("CTU_STUDY_REPO", HOME / "quaimlres_road"))
COACH_MD = Path(os.environ.get("CTU_COACH_MD", HOME / "Custom/Projects/ctu-plan/COACH.md"))
KINTSUGI = Path(os.environ.get("CTU_KINTSUGI", HOME / "Custom/Projects/kintsugi"))
PLAN_PDF_TEXT = APP_ROOT / "backend" / "data" / "plan.txt"
# Where an install keeps what it records: the database, notebook pictures, the coach's and the user's pictures and the
# automatic backups all sit in one data folder, outside the app's own files, so deleting or updating the app never takes
# them. data_dir_for (app/paths.py) picks it; installs from before the data folder keep backend/data/ctu.db.


DB_PATH = (Path(os.path.expanduser(os.environ["CTU_DB"])) if os.environ.get("CTU_DB")
           else data_dir_for(dict(os.environ), HOME, LEGACY_DB, os.name == "nt") / "ctu.db")
# everything else the app records lives next to the database
DATA_DIR = DB_PATH.parent

# Khan Academy content comes through Kolibri (Learning Equality's offline platform, Khan's partner for it):
# ./setup-khan.sh installs it and fetches the channel; the app reads the files it downloads.
KOLIBRI_HOME = Path(os.path.expanduser(os.environ.get("CTU_KOLIBRI_HOME", "") or HOME / ".local/share/ctu-app/kolibri"))
KOLIBRI_BIN = os.path.expanduser(os.environ.get("CTU_KOLIBRI_BIN", ""))
KOLIBRI_URL = os.environ.get("CTU_KOLIBRI_URL", "http://127.0.0.1:8726").rstrip("/")

# The plan's first day and its study days come from the active plan (app/profile.py), read on every call: approving a
# plan in onboarding takes effect without a restart.
def start_date() -> date:
    return profile.start_date()


def study_weekdays() -> set[int]:
    return profile.study_weekdays()


WEEKDAY_TR = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
WEEKDAY_TR_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# How many study days past today exist as "reference" versions.
HORIZON_STUDY_DAYS = 2

# Monitoring thresholds (minutes)
IDLE_STUCK_MIN = 20
COMPILE_FAIL_STREAK = 3
OVERTIME_FACTOR = 1.5
NO_HINT_BEFORE_MIN = 30


def has_api_key() -> bool:
    """Some AI provider is set up (a key in .env, or the local model switched on). See app/providers.py."""
    from . import providers
    return providers.any_ready()


# The fake clock (CTU_NOW) is for trying flows, never for real data: it only runs when the database, the
# study repo and COACH.md all point somewhere else (demo.sh does this with copies).
_FAKE = os.environ.get("CTU_NOW", "").strip()
if _FAKE:
    _missing = [k for k in ("CTU_DB", "CTU_STUDY_REPO", "CTU_COACH_MD") if not os.environ.get(k)]
    if _missing:
        raise RuntimeError(
            "CTU_NOW is set but " + ", ".join(_missing) + " still point at your real data. The fake clock would write "
            "test days into the real database, PROGRESS.md and COACH.md. Use ./demo.sh (it works on copies), or set "
            "CTU_DB, CTU_STUDY_REPO and CTU_COACH_MD to copies as well. Remove CTU_NOW from .env for real use.")


def _parse_fake(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    # a value with a UTC offset becomes local wall-clock time; everything else in the app is naive local time
    return dt.astimezone().replace(tzinfo=None) if dt.tzinfo else dt


def _fake_clock() -> tuple[datetime, datetime] | None:
    """(fake start, real moment it started). The real start is saved next to the database, so a restart
    or a --reload continues the fake clock instead of jumping back to CTU_NOW."""
    if not _FAKE:
        return None
    base = _parse_fake(_FAKE)
    f = DB_PATH.with_name(DB_PATH.name + ".clock.json")
    try:
        saved = json.loads(f.read_text())
        if saved.get("fake") == _FAKE:
            return base, datetime.fromisoformat(saved["real_start"])
    except (OSError, ValueError, KeyError):
        pass
    real = datetime.now()
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"fake": _FAKE, "real_start": real.isoformat()}))
    except OSError:
        pass
    return base, real


_CLOCK = _fake_clock()
FAKE_CLOCK = _CLOCK is not None


def now() -> datetime:
    """Wall clock (naive local time). With CTU_NOW the fake clock keeps ticking from its saved start."""
    if _CLOCK:
        base, real_start = _CLOCK
        return base + (datetime.now() - real_start)
    return datetime.now()


def today() -> date:
    return now().date()


def week_index(d: date) -> int:
    """Week 0 is the plan's first week (23-29 November 2026 in the CTU plan)."""
    return (d - week_start()).days // 7


def week_start() -> date:
    """Monday of the plan's first week: weeks run Monday to Sunday even when a plan starts midweek (the CTU plan
    starts on a Monday, so for it this is the start date itself)."""
    s = start_date()
    return s - timedelta(days=s.weekday())


def next_study_day(d: date) -> date:
    days = study_weekdays()
    d = d + timedelta(days=1)
    if not days:   # no plan yet: every day counts, so callers never loop forever
        return d
    while d.weekday() not in days:
        d += timedelta(days=1)
    return d
