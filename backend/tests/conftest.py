"""Every test runs against throwaway copies: its own database, study repo, COACH.md and Kintsugi folder.
The environment is set before the app is imported, because paths are read at import time."""
from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(tempfile.mkdtemp(prefix="ctu-tests-"))
os.environ.update({
    "CTU_DB": str(ROOT / "data" / "ctu.db"),
    "CTU_STUDY_REPO": str(ROOT / "repo"),
    "CTU_COACH_MD": str(ROOT / "COACH.md"),
    "CTU_KINTSUGI": str(ROOT / "kintsugi"),
    "CTU_KOLIBRI_HOME": str(ROOT / "kolibri"), "CTU_KOLIBRI_BIN": str(ROOT / "no-kolibri"),
    "CTU_KOLIBRI_URL": "http://127.0.0.1:9",
    "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "", "CTU_LLM": "", "GEMINI_API_KEY": "",
})
os.environ.pop("CTU_NOW", None)

from app import config, db  # noqa: E402

COACH_TEXT = """# Koçluk dosyası

## Geçme eşikleri (altında "öğrenildi" sayılmaz)
- Khan unit test ≥ 90%

## Haftalık şablon (onaylandı)
- 10:00–13:00 Matematik

## Haftalık log
### Hafta 0 — 23–29 Kasım 2026
Plan: Khan Algebra 1.
"""


def set_now(dt: str | datetime) -> None:
    """Freeze-ish the app clock: it reads config._CLOCK on every call."""
    base = datetime.fromisoformat(dt) if isinstance(dt, str) else dt
    config._CLOCK = (base, datetime.now())


@pytest.fixture(autouse=True)
def fresh(tmp_path):
    with db._lock:
        if db._conn is not None:
            db._conn.close()
        db._conn = None
        db._tx_depth = 0
    for p in (ROOT / "data", ROOT / "repo", ROOT / "kintsugi", ROOT / "kolibri"):
        shutil.rmtree(p, ignore_errors=True)
    (ROOT / "repo").mkdir(parents=True)
    (ROOT / "kintsugi" / "include").mkdir(parents=True)
    (ROOT / "COACH.md").write_text(COACH_TEXT)
    set_now("2026-11-23T10:00")
    from app import files, profile
    files._own.clear()
    # most tests are about the CTU plan; a test of a new install calls new_install()
    db.ex("UPDATE profile SET preset='ctu' WHERE id=1")
    profile.reload()
    yield ROOT
    profile.reload()
    config._CLOCK = None


def new_install() -> None:
    """The database as a new install has it: no plan until onboarding."""
    from app import profile
    db.ex("UPDATE profile SET preset='none' WHERE id=1")
    profile.reload()


@pytest.fixture
def seeded(fresh):
    from app import seed
    seed.seed_if_empty()
    return fresh
