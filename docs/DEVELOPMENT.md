# Waymark: development notes

How Waymark works inside, for working on it from source. Using the app: [README](../README.md) and [INSTALL](../INSTALL.md).

A new install has no plan and starts with plan setup ([Your own plan](#your-own-plan)). One plan is also built into the
code as a preset, the **CTU plan** (`backend/app/presets/ctu.py`): the author's own plan, with Khan Academy maths,
Beej's Guide to C and a C++ reading project, which watches a study repo and writes to a coach file. It is the reason for
the parts of these notes that name `CTU_STUDY_REPO`, `COACH.md`, Kintsugi or Kolibri; a plan made in plan setup doesn't
use them. Paths such as `~/quaimlres_road` below are that preset's defaults.

It runs on this machine only: the server binds to `127.0.0.1` and has no login screen. Don't expose the port.

Other web pages open in your browser can't drive it: the server only answers requests addressed to `127.0.0.1`/`localhost`, refuses state changes from other origins, and requires an `X-CTU: 1` header (sent by the UI) on every change.

What it does:
- Shows each study day as fixed blocks: the blocks of the plan's weekly schedule (the CTU preset has Math, English, Math II, an evening block and the end-of-day test).
- Tracks time per task.
- Compiles your `.c` exercises when you save them.
- Runs a plan of your own unit by unit: reading and problems from the sources the plan names, then a closed-book unit check; below the pass mark the unit comes back as a review and a retake.
- Plays the Khan unit's videos (CTU preset), runs its exercises and its unit test inside the app (Khan content through Kolibri) and records the score.
- Writes and grades end-of-day tests and C quizzes.
- Closes the day and plans the next ones.
- Includes a coach chat with tools over this data.
- Keeps a personal notebook: pages of Markdown with LaTeX maths, function graphs, pictures, and boards where cards are joined with arrows and written over with a pen.
- Counts XP and a level from the recorded work, so progress shows up as you go.

The logo is a vector mark in `frontend/public/`: `waymark-light.svg` (dark ink, for light backgrounds), `waymark-dark.svg` (light ink, for dark backgrounds) and `favicon.svg` (switches between the two with the system's light/dark setting). In the top bar the same mark is drawn inline in the current text colour, so it follows the app's theme (System included) as it changes.

## Requirements

- [uv](https://docs.astral.sh/uv/) (it brings Python 3.13 itself)
- Node.js and npm, to build the UI from source (a package from `package.sh` ships it built)
- `gcc`: compile checks for exercises and code questions (only plans with code)
- `git`: commit detection in the study repo (read only; only plans with a study repo)
- Optional:
  - `bwrap` (bubblewrap): model-written test code runs isolated (no network, no access to your files). Without it, it runs with resource limits only
  - `clang-format`: tidier code in test questions
  - `gh`: GitHub profile card
  - `xdg-open`: "open folder" buttons
  - [Kolibri](https://learningequality.org/kolibri/), for Khan Academy inside the app. `./setup-khan.sh` installs it (see [Khan Academy](#khan-academy))

## Start

```bash
./run.sh --open           # http://localhost:8723, opened in the browser
```

The API key goes in **Settings → AI key** (or the first page of plan setup); it is checked with Anthropic and kept in the data folder as `api-key`, readable only by you, and never put into a backup file. A key in `.env` (`ANTHROPIC_API_KEY`, copy `.env.example`) or in the environment wins over it and can't be changed from the app.

`run.sh` checks for `uv` and `gcc`, reinstalls UI packages when `package.json` changed, rebuilds the UI when its sources changed, starts Kolibri if it is set up, then starts the server. Set `PORT=...` to use another port. On Windows, `run.ps1` does the same.

UI development mode uses two terminals:

```bash
cd backend && uv run uvicorn app.main:app --port 8723 --reload
cd frontend && npm run dev          # http://localhost:5173, proxies /api to 8723
```

## Your own plan

A new install has no plan: every page that needs one opens **Plan setup** (`#/setup`) instead.

1. **Questions** (`Setup.tsx`): first a choice between a **quick start** (what you study, the goal with an optional date, study days and net hours; the model assumes the rest and says what it assumed in the draft's notes) and the detailed questions: field, level, goal and deadline, what you already know, topics, preferred sources, study days, the day's start and end, net hours a day, start date, whether the plan has programming. Optionally a plan file of your own (Markdown or text, for example a COACH.md): it is read once to shape the draft and never changed. The answers stay in the browser until you send them.
2. **Draft** (`backend/app/onboarding.py`): the model writes a draft in a strict JSON shape: tracks of units (objective, practice, sessions, sources), a weekly schedule, goals, a roadmap by month, the unit pass mark, and the plan-specific parts of the coach and test prompts. The app then repairs what it can and says what it changed: overlapping blocks are cut, blocks outside your day clipped, each day ends with one test block, a week is capped at 80 hours, links that aren't https or don't open are dropped (the source stays by name). It also works out the day the last unit ends from the week's blocks and each unit's sessions (`tracks.finish`), keeps the deadline (from the answers, or one named in a change request such as "my midterm is in 3 weeks"), and says so when the last unit falls after the deadline or the plan's name or summary claims a length the units don't fit (such a summary sentence is dropped). The roadmap is redrawn from the schedule (the units that end each month), so it can't run past the plan's end; only past the units' end, before a later deadline, do the model's own milestones stay. Each course (track) can have its **own exam date**, taken from your words or set on the review page; the app checks each course's last unit against its own exam. Drafting runs in the background; the page shows it working and survives a reload.
3. **Review**: the schedule as a week grid, the tracks and their units, goals, the roadmap and the repair notes. **Ask for changes** sends your words and the draft back to the model; **Approve** asks once more, then:
   - backs up the database (`backups/ctu-before-plan-….db`),
   - stores the plan in the database (the `plan` entry; the plan's source of truth),
   - sets the profile's plan to `custom`, resets the unit cursor and removes planned days from today on that weren't started,
   - plans today (if it is a study day) and the next days.

Changing the plan later is the same flow from **Settings → Plan → Change the plan…**: the questions come back filled in with the approved plan's answers. Days already started stay as they were.

Per-course exam dates (`tracks.remap`): once a course's exam is over its blocks go to the course with the nearest exam still ahead, and in the last 7 days before an exam a course that still has sessions left takes the blocks of courses whose exam is more than 21 days away (or have none). Days already stored keep their blocks; **Why this plan?** says when a block moved and why. Exam dates can be changed in **Settings → Plan** and show on the calendar.

The review page, **Settings → Plan** and the calendar show the deadline and the day the last unit is projected to end (from the current cursor, assuming every unit check passes the first time; a retake moves it later).

**How a plan of your own runs** (`backend/app/tracks.py`):
- Each block of a track gets the track's current unit: reading (the unit's sources), problems (its practice) and, in the unit's last session, a **unit check**: a 15-minute closed-book test of five questions written from the unit's objective. Its score is kept as `unit_quiz` with the item `Track · Unit`.
- The end-of-day test task fills its block (30 minutes of test, the rest for reading the results), so a day adds up to the net time the plan promised.
- A locked day up to three weeks ahead opens as a preview: each block's time, track, unit and session, and whether the unit check falls on it (`tracks.outline`). Task texts stay hidden until the day opens.
- Every problem and review task has a **Practice set** button: the app writes original problems of the kind the task asks for (no textbook needed), times and checks them on the Tests page, and keeps the wrong answers as sticking points of that task. It is the task's main button (on the focus card too) and starts the task's clock. A review task's set aims at the open sticking points. The planner and the coach are told to send problem work here, never to exercise numbers in a book or an answer key. One open set per task; a practice test the coach makes in chat stays unscored and makes no sticking points.
- Every test is recorded question by question: the test page keeps the seconds spent on each question (while the tab is in view), how often it was opened and how often a given answer was changed (`test_trace_<id>` in `kv`, copied into the results on submit). Starting, pausing and submitting are events, and a submission's event names the wrong and empty questions, practice tests made in chat included. The coach sees the last three days' tests question by question in its snapshot (wrong ones with the answer given and the right one), and has `get_test` (one test in full) and `get_activity` (the event log), so it never asks which questions went wrong.
- A study task of a plan of your own has a **Lesson** button: the coach writes a short lesson in the app (the idea, definitions, a worked example of a different problem than the task's, common mistakes, what to read next in the source, two self-check questions). It is written once and kept on the task (`lessons.py`).
- Each course's row under exam dates shows when its units end and how many review days that leaves before its exam; after its last unit the course's blocks review earlier units until the exam.
- Programming follows the setup answer unless a change request asks to add or remove it; when your answers mention programming but the answer says no, the draft says so.
- Math in coach replies, task texts and questions is repaired before KaTeX sets it when a command lost its backslash (`<varepsilon` → `<\varepsilon`), so it reads right on screen and to screen readers.
- A task keeps the sources the approved plan gave its unit, first; the day's model may add a link but can't replace a real source with a name it made up.
- **Why this plan?** under the day's title says, from the day's tasks, where each track is in its units, why a unit is studied again, what was carried over and which sticking points are open.
- Progress has a **By topic** section: every finished test's answers grouped by topic, weakest first, with the recent attempts and their trend, the last miss as an example, open sticking points, notes on it, and a button to work on it with the coach (`insights.topics`). The score chart has a summary for screen readers and a **Show as a table** view.
- Generated questions are checked before a test starts: a model reads each one exactly as the test screen shows it and drops any that leave out what they need ("the piecewise function" with no function); the dropped ones are asked for again once. If one still slips through, **This question is broken** on the review takes it out of the score (a scored check is passed or failed again on the rest) and closes its sticking point.
- The coach's line under the chat box says what help it gives right now: with no task running it explains directly; during a learning task it asks guiding questions for the first 30 minutes, then explains. **Explain now** opens explanations early for that task (still never the solution), and the coach is told you asked.
- Below the pass mark, the next block of the same track opens with a review of the unit and a retake of the check. The cursor (`track_cursor`) moves on only when the unit is passed.
- **Taking a unit out.** Every unit on the review page and in **Settings → Plan → Units in the plan** has a tick; unticked, the unit gets `"skip": true` and stays in the list (its number, scores and done tasks are kept, and ticking it again puts it back). The cursor steps over it everywhere it walks (planning, the projected end, the preview, runway); it gets no tasks, no unit check and no retake, the day's model is told it is removed, and its unfinished tasks are not carried over. On the draft the end date, the courses' last unit days and the roadmap follow at once, and a change request keeps it out. On the approved plan the planned days nobody has started are taken out and planned again from the rewound cursor (`planner._drop_ahead`), so the remaining units move up; started days keep their tasks. A passed unit can't be taken out, and a course keeps at least one unit. A unit put back after the cursor went past it is studied next, then the track goes on where it was (`done` on the cursor position lists the units in between, so they aren't studied twice).
- **Studying on a day off.** A day off from today on (not before the start) offers **Study on this day**, from the calendar or the week strip. It is for that date only (kv `extra_days`, `{date: weekday}`; the weekly pattern doesn't change) and copies the blocks of one of the plan's study weekdays, end-of-day test included. The untouched planned days after it are planned again from the rewound cursor, so it takes the next work and the days after it move up. From then on it is an ordinary study day: timer, closing, carry-over, the end-of-day test, XP. For the streak it counts when studied (30 minutes) and never breaks it when not. While nobody has worked on it, **Take it back** removes it and returns its work to the days after.
- A task that already has a score is never carried over or rebuilt.
- With a key, the planner may reshape the next day within the plan's rules; without one, the day is built from the cursor alone.

**`PLAN.md`** (`backend/app/planlog.py`): the app writes the plan into `PLAN.md` in the data folder after every change: the summary, the weekly schedule, each track with its units marked `[x]` passed, `[~]` tried, `[>]` current and `[ ]` to do, goals, the roadmap and a log (approvals, weekly summaries, notes the coach adds). It is rewritten as a whole, so edits to it are lost; it is there to read, share or download (**Settings → Plan → Download PLAN.md**, `GET /api/plan/file`).

API: `GET /api/plan`, `GET /api/onboarding`, `POST /api/onboarding/draft`, `/change`, `/discard`, `/approve` (with `{"confirm": true}`), `PUT /api/onboarding/unit` and `PUT /api/plan/unit` (`{track, unit, on}`), `POST/DELETE /api/day/{date}/extra` (`{like}`: the study weekday to copy), `GET/PUT/DELETE /api/settings/key`.

## Giving it to a friend

The easy way is the packaged program: one file per system, nothing else to install. Push a version tag and GitHub
Actions builds it on Linux, Windows and macOS and puts the files on the repo's Releases page:

```bash
git tag v2026.11.23 && git push origin v2026.11.23    # .github/workflows/release.yml
packaging/build.sh                                     # or: build for this computer only, into packages/
```

| System | File | Start |
|---|---|---|
| Windows | `Waymark-<version>-windows.exe` | double-click (unsigned: *More info → Run anyway* the first time) |
| macOS | `Waymark-<version>-macos-arm64.dmg` / `-x86_64.dmg` | drag to Applications; the first time *System Settings → Privacy & Security → Open Anyway* |
| Linux | `waymark-<version>-linux-x86_64` | `chmod +x`, start; it adds itself to the applications menu |

It starts the server on this computer and opens it in the browser; starting it again while it runs only opens a tab
(on macOS: click the Dock icon; *Quit* in the Dock stops it). With no tab open for 15 minutes it stops by itself.
Inside is `backend/app` (PyInstaller, `packaging/waymark.spec`), the built UI and the icon; the start is
`backend/app/launcher.py`. The data folder is the same as below; the AI keys' `.env` is in the data folder too, since
the program's own files may be read-only. Its log is `waymark.log` there. `packaging/build.sh` starts each build once
on an empty data folder (`--smoke-test`) and fails if the API or the page doesn't answer.

**Updates.** The packaged program carries its version (`version.txt`, written by `build.sh`). When the app is opened it
asks GitHub for the latest release (`backend/app/updates.py`, at most every 6 hours, switchable in Settings → Updates);
a newer one brings up the update screen (`frontend/src/Update.tsx`): update now, download it yourself, not now, skip
this version. Updating downloads the file for this system, checks its size and the SHA-256 GitHub lists, swaps it in
for the running program (Linux: replaced in place; Windows: the running `.exe` renamed to `.old`; macOS: the `.dmg`
mounted and the `.app` swapped), and starts the new one with `--after-update PORT`, which waits for the port and takes
it over; the tab reloads into it. The screen shows the release notes up to an `<!-- install -->` line, which the release
workflow writes from the tag's message, so tag with a message: `git tag -a v2026.12.1 -m "- What changed"`.
`CTU_UPDATE_FEED=<url>` points the check at another address (a local release JSON, to try a whole update), and
`CTU_UPDATE_CURRENT=<version>` makes a source checkout pretend to be that version to see the screen.

The older way, a folder that needs uv:

```bash
./package.sh              # packages/waymark-YYYY.MM.DD.tar.gz and .zip
```

The package holds the backend code, the dependency lock, the built UI, `run.sh`, `run.ps1`, `install.sh` and `INSTALL.md` (as its README). Nothing personal goes in: no database, notes, pictures, backups, `.env`, API key, `backend/data/plan.txt` or the authors list from `pyproject.toml`; the script refuses to finish if a database, key or e-mail address would be inside.

Your friend needs only uv: `./install.sh` once (Python packages; on Linux also a menu entry), then `./run.sh --open`, or `run.ps1` on Windows. Their data goes to their own data folder and the first page they see is plan setup.

## Khan Academy

Khan Academy content is part of the CTU plan only.

Khan's videos, exercises and unit tests run inside the app; you don't go to khanacademy.org or type scores. The content comes through [Kolibri](https://learningequality.org/kolibri/), Learning Equality's offline learning platform and Khan Academy's partner for offline use. Kolibri keeps a copy of the "Khan Academy (English - US curriculum)" channel. Khan's own data and API aren't used.

```bash
./setup-khan.sh     # once: installs Kolibri (uv tool, Python 3.11), fetches the channel catalogue (~120 MB)
./run.sh            # starts Kolibri on 127.0.0.1:8726 if it's set up, then the app
```

- **Downloads.** The app downloads the current unit and the next one in the background with Kolibri's importer: low-res videos, English/Turkish subtitles and exercise packages, about 30–80 MB per unit (Algebra 1 is ~1 GB in all). Opening a unit that isn't on disk yet starts its download. Data lives in `~/.local/share/ctu-app/kolibri` (`CTU_KOLIBRI_HOME`).
- **Videos** play in the study task, starting at 0.75× with English subtitles (Türkçe in the CC menu).
- **Exercises** use Khan's own questions and hints. The app shows number, expression, multiple-choice and dropdown questions (about 90% of Algebra 1) and checks them on the server. Expressions are compared the way Khan does it, so `2(x+1)` and `2x+2` both count unless the question asks for a form. Answers never reach the browser before you check. An exercise is **mastered** at 5 right of the last 7 first tries, as on Khan. A hint before your first answer, or **Show solution**, makes that try count as a miss.
- **Questions the app can't show** (drawing graphs, drag and drop) are skipped in the app. The exercise has a **Kolibri** button that opens it in Kolibri's own player, in a new tab (Kolibri refuses to be embedded).
- **Unit test.** The unit-test task has **Start unit test**: 10–20 questions drawn from the unit's exercises, favouring ones you haven't practised, untimed, saved as you go. Submitting grades it, saves the score, moves the cursor at ≥ 90% and writes `math/log.md`, as a typed score did. The first submitted test adds one line to `COACH.md` noting that the unit test moved into the app.
- **Without Kolibri** everything else works; Khan tasks keep their khanacademy.org links, and a score can still be typed under "Took the test on khanacademy.org instead?".
- Kolibri listens on `127.0.0.1` only (`setup-khan.sh` writes `options.ini`; its default is every network interface).

## Try it without touching real data

```bash
./demo.sh                      # fake clock at 2026-11-23T10:05
./demo.sh 2026-11-24T21:40     # or any moment you want to test
```

`demo.sh` copies the study repo and `COACH.md` to `~/.cache/ctu-demo/`. It uses a separate database and serves on http://localhost:8724. Each run starts from a fresh copy; it refuses to start while something (an earlier demo) still listens on that port.

`CTU_NOW` only works together with copies: the server refuses to start with `CTU_NOW` unless `CTU_DB`, `CTU_STUDY_REPO` and `CTU_COACH_MD` are all set (see [Clock override](#clock-override-ctu_now)).

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEYS`, `OPENAI_API_KEYS`, `OPENROUTER_API_KEYS`, `GROQ_API_KEYS`, `GEMINI_API_KEYS`, `LOCAL_LLM_API_KEYS` | (empty) | AI keys, several per provider, comma separated. The singular names (`GROQ_API_KEY`) are read too. Settings → AI providers adds and removes them here; models, the provider order and moving on to the next provider are chosen there too (defaults are in `backend/app/providers.py`) |
| `ANTHROPIC_WORKSPACE_ID` | (empty) | Only for an Anthropic key that isn't scoped to a workspace |
| `CTU_STUDY_REPO` | `~/quaimlres_road` | Study repo: watched, compiled, PROGRESS.md and math log |
| `CTU_COACH_MD` | `~/Custom/Projects/ctu-plan/COACH.md` | Coach file |
| `CTU_KINTSUGI` | `~/Custom/Projects/kintsugi` | Kintsugi source for the in-app reader (read only) |
| `CTU_DATA_DIR` | `~/.local/share/waymark` (see [Data](#data-backup-and-reset)) | The data folder: database, pictures, backups |
| `CTU_DB` | `ctu.db` in the data folder | The database alone; pictures and `backups/` go next to it |
| `CTU_KOLIBRI_HOME` | `~/.local/share/ctu-app/kolibri` | Kolibri's data: the Khan channel catalogue and downloaded units |
| `CTU_KOLIBRI_BIN` | `kolibri` on `PATH` | The `kolibri` command, if it isn't on `PATH` |
| `CTU_KOLIBRI_URL` | `http://127.0.0.1:8726` | Kolibri's own player (questions the app can't show) |
| `CTU_NOW` | (empty) | Fake clock for testing. Only accepted together with `CTU_DB`, `CTU_STUDY_REPO` and `CTU_COACH_MD`; use `./demo.sh` |
| `PORT` | `8723` | Port for `run.sh` (environment variable, not read from `.env`) |

`.env` is git-ignored. Never commit it.

### Without an API key

Plan setup needs a key: the draft is written by the model. With the CTU plan, the app still runs without one:
- Days are built from the template in `backend/app/curriculum.py`. Exercises show as placeholders.
- The coach is off.
- End-of-day tests and C quizzes come from a built-in question bank (`backend/app/offline.py`), picked from the Beej chapters, Khan units and Kintsugi reading the day covered. Monday of Week 0 has its own prepared set.

## Days and the plan

This section describes the built-in CTU plan; a plan of your own has its own days and blocks ([Your own plan](#your-own-plan)). Weeks always run Monday to Sunday: a plan that starts midweek has a short Week 0.

- Study days are Monday, Tuesday, Wednesday, Saturday and Sunday. Thursday and Friday are off.
- The plan's frame lives in one place, the `ctu` preset (`backend/app/presets/ctu.py`), read through `backend/app/profile.py` (which reads a plan of your own from the database in the same shape):
  - the first day and the study days;
  - each weekday's blocks and times;
  - how many minutes each block takes;
  - the pass marks and the goals on the Profile page;
  - the parts of the coach, planner and test prompts that describe this plan.

  It is plain data; a plan made in plan setup takes the same shape. The prompts are assembled from these parts in `backend/app/prompts.py`. `backend/tests/test_preset_golden.py` compares the whole plan (days built for many cursor states, prompts, schedule, pass marks) with a snapshot, `backend/tests/golden/ctu_preset.json`. A change to the preset fails it on purpose; regenerate the snapshot only after a plan change is approved: `CTU_GOLDEN_WRITE=1 uv run pytest tests/test_preset_golden.py`.
- Day states:
  - Today is the only editable day.
  - Future days are locked and show only their name (a plan of your own also shows an outline up to three weeks ahead).
  - Past and closed days are read only.
- On first launch, Week 0 is seeded:
  - Monday exactly as assigned.
  - Tuesday and Wednesday as reference versions.
- After that, the planner keeps two study days ahead of the last closed day. A new day:
  1. Starts from the curriculum template (Khan Algebra 1 then Algebra 2 units, Beej's Guide to C chapters 1–12, Kintsugi files in order).
  2. Is reshaped by the model when a key is set.
  3. Progress through the curriculum is kept in the `cursor` entry of the database.
- **Next phases.** The roadmap's next steps are built in but stay off until you approve them (Profile → Health → Approve; `POST /api/phases/<key>/approve`), because the plan doesn't change without your approval. An approval or withdrawal is also written to the COACH.md log.

  | Phase | When a track runs out, it continues with |
  |---|---|
  | `c_ds` — C data structures + USACO Bronze | After Beej 12: Mon/Wed C evenings build dynamic array, linked list, stack, queue, BST, merge sort, quicksort in `c/ds/` (build + ASan/valgrind, then a ≤45 min rewrite from an empty file). Sunday C block: USACO Bronze in `usaco-guide/` |
  | `kintsugi_rewrite` — Kintsugi rewrite | After the last file group: page I/O, buffer pool, serializer, B+tree node and WAL rewritten from your notes in `cpp/kintsugi/rewrite/` (header, implementation, tests, then compare with the original) |
  | `khan_geometry` — Khan Geometry | After Algebra 2: the Geometry course, unit by unit |

  Until a phase is approved, a finished track switches to review and oral prep instead of going empty. A warning appears a week before new material runs out (`RUNWAY_WARN_DAYS`).
- **Closing a day** (button on the day page) first shows a checklist (end-of-day test submitted, no timer running, day notes). Closing with an open item asks for confirmation. Then:
  1. In one database transaction: running timers stop, the day is marked closed, unfinished evening and English work moves to the next matching block.
  2. The day is written to `PROGRESS.md` (and on Sunday a weekly line to `COACH.md`).
  3. The database is backed up.
  4. The next day is rebuilt from the results, **unless you already started working on it** (a started task, a score or a test): such a day is never rebuilt, only added to.
  5. New reference days are created.

  Steps 2–5 are recorded. If one fails, a warning shows at the top of every page and in the Health panel, and the step is retried every 10 minutes (or right away with **Retry now**).
- When a day is closed automatically:
  - A day left open is closed at midnight if the server is running.
  - Otherwise it is closed at the next start, before the UI is served.
- Timers only count while you are around. The open app pings the server every 30 seconds; file saves, compiles and reader activity count too. After 30 minutes with no sign of life (laptop asleep, app closed) a running task is paused and the time stops 5 minutes after the last activity. Restarting the server pauses running tasks the same way.
- Tests: a test whose time runs out is submitted with the answers saved so far (by the page, or by the server if the tab is closed). The coach is off only while a test is in progress and within its time. A test whose generation was cut off by a restart is marked failed so **Retry** works.

## What gets written where

| File | Who writes it, and when |
|---|---|
| `~/quaimlres_road/PROGRESS.md` | The app, when a day closes, and again if the day's notes change or its end-of-day test is submitted after the close. Its section sits between `<!-- ctu:YYYY-MM-DD -->` and `<!-- /ctu:YYYY-MM-DD -->` markers and only that part is ever replaced. If you already wrote a `## YYYY-MM-DD` section yourself, the app's record goes under it (`#### Uygulama kaydı`) and your text stays |
| `~/quaimlres_road/math/log.md` | The app, when a Khan unit test is submitted in the app or a score is typed. One row per date and unit: entering the score again replaces that day's row. The file is created with a header if missing |
| `~/Custom/Projects/ctu-plan/COACH.md` | The app appends a one-line weekly summary when a Sunday closes, under a `### Hafta N` heading it adds if missing. The in-app coach may also append lines. Every line is one line, starts with `- [ctu-app YYYY-MM-DD]`, and is added in append mode: the rest of the file is never rewritten. If the thresholds or weekly schedule section changes, a warning asks you to check it |
| `PLAN.md` (data folder) | The app, for a plan of your own, after every change to it (approval, unit results, weekly summary, coach notes). Rewritten as a whole |
| Your plan file (plan setup) | Never written: it is read once while the draft is made |
| `.c` files, summaries, essays | Only you. The app reads them: it compiles `.c` files into a temporary folder and checks that summary and essay files exist. Neither the app nor the coach writes to them |
| Study repo folders | Never created by the app. Opening a resource folder that doesn't exist opens its nearest existing parent |

More notes on writes:
- Rewrites of `PROGRESS.md` and `math/log.md` are atomic (temporary file, then rename). If the file changes between the app reading and writing it (an editor saved), the app starts over from the new content instead of overwriting it.
- Every external write is logged; the last ones are listed in the health panel on the Settings page.
- The repo watcher ignores the app's own writes, so they don't count as your activity.
- The app never commits or pushes. In the study repo it only reads git (`rev-parse`, `log`). For the profile page it runs `gh api user`. Closing the day doesn't push: you run `git add -A && git commit && git push` yourself.

## Data, backup and reset

Everything an install records lives in one **data folder**, apart from the app's own files, so deleting or updating the app never takes it:

| Install | Data folder |
|---|---|
| Linux, macOS (new) | `~/.local/share/waymark/` (or `$XDG_DATA_HOME/waymark/`) |
| Windows (new) | `%APPDATA%\Waymark\` |
| One that already has `backend/data/ctu.db` | `backend/data/`, unchanged |
| `CTU_DATA_DIR` set | that folder |

It holds:
- the database (`ctu.db`);
- the notebook's pictures (`notes/`), the coach's picture (`coach/`) and your own (`me/`);
- the automatic backups (`backups/`).

A picture you add is copied in, so deleting the original file later loses nothing. **Settings → Data** shows the folder.

### Backup file

**Settings → Data → Download a backup** saves the whole install as one zip:
- the database;
- every picture;
- a `manifest.json`.

The API key is not in it (it lives in `.env`), and neither are Kolibri's Khan content (fetch it again with `./setup-khan.sh`) or the study repo (your own folder).

**Restore from a backup…** replaces everything with a backup file, after asking. Before that:
- a running task is paused;
- the current database is kept as `backups/ctu-before-restore-….db`;
- the current pictures are kept in `backups/files-before-restore-…/` (the last 3 are kept).

A backup from an older version is upgraded when it opens. One from a newer version is refused. A restore waits while a test is being written or days are being planned. The file is checked before anything is replaced:
- only the entries Waymark itself writes are accepted;
- nothing is unpacked to a path taken from the file;
- the database must pass SQLite's integrity check.

### Local profile

There are no accounts or passwords: the data stays on this computer. The **Profile** page has your name and picture.

- **New install:** if the `gh` command is signed in, it asks once whether to show that GitHub profile instead.
- **Install from before the profile existed:** it keeps showing GitHub as before.
- **Switching:** either way, one click switches between the two.

### The database file

The database is SQLite, in WAL mode. Recent changes sit in `ctu.db-wal` until SQLite folds them into `ctu.db` (the app does this when it shuts down), so **copying `ctu.db` alone while the app runs can give an empty or outdated backup**.

Backups are automatic, in `backups/` inside the data folder:
- `ctu-YYYY-MM-DD.db` each time a day closes,
- `ctu-YYYY-MM-DD-start.db` at the first start of a day,
- `ctu-before-vN-....db` before the database schema is upgraded,
- `ctu-before-plan-....db` before a plan from plan setup is approved.

The newest 21 are kept. Each one is a complete database: to restore, stop the app and copy it over `ctu.db` (delete `ctu.db-wal` and `ctu.db-shm`). For a manual backup while the app runs:

```bash
sqlite3 ~/.local/share/waymark/ctu.db ".backup backup-$(date +%F).db"   # or backend/data/ctu.db on an older install
```

The schema is versioned (`PRAGMA user_version`); upgrades run in order at startup (`MIGRATIONS` in `db.py`).

Scripts and `python -c` imports of the backend refuse to open the real database unless `CTU_DB` is set explicitly. Only the server opens it by default.

To reset:
1. Stop the app.
2. Delete `ctu.db`, `ctu.db-wal` and `ctu.db-shm`.
3. Start again. A new database starts without a plan and opens plan setup (`CTU_DB` pointing at a fresh file does the same).

The reset only covers the database. Lines already written to `PROGRESS.md`, `math/log.md` and `COACH.md` stay there; the app's parts are easy to find by their `ctu:` markers and `[ctu-app ...]` tags.

## Clock override (`CTU_NOW`)

```
CTU_NOW=2026-11-23T10:30
```

How it behaves:
- The server refuses to start unless `CTU_DB`, `CTU_STUDY_REPO` and `CTU_COACH_MD` are also set, so the fake clock never touches real data. `./demo.sh` sets all of them to copies.
- The app counts time from that moment. The real start is saved next to the database (`ctu.db.clock.json`), so a restart or a `--reload` continues the clock. Changing `CTU_NOW` starts it over.
- A value with a UTC offset (`2026-11-23T10:30+01:00`) is converted to local time.
- A banner at the top of every page says when the demo clock is on.

Leave `CTU_NOW` empty in real use.

## Coach panel

The coach button (or **]**) opens the panel. The panel's head has a pop-out button: the same panel, whole, as a floating window over the page (moved by its head, sized from its corner, both remembered; it stays over full-screen tests); the same button docks it again. With the panel docked on a window narrower than 1180 px the sidebar shows its icons only, so the page keeps its width. The message box is one surface with a toolbar: the coach's mode on the left (its tooltip is the 30-minute rule; **Explain now** sits beside it while explanations are closed), the coach's model and its thinking effort (changed right there) and the send button on the right. A new chat starts with suggestions picked from what's going on (the running task, the next one, an open sticking point); one click sends it, the ones with a pencil fill the box for you to finish. After a reply, follow-ups (**Simpler**, **Give an example**, **Quiz me**, **In Turkish**) are one click. The coach's picture is set in its settings (**Picture**: any image, cut to a square and kept next to the database in `coach/`); without one it shows its initial.

## Studying: one question at a time

Khan practice, the Khan unit test and the end-of-day test open as a full-screen study sheet: the question centred in a serif on dot paper, a progress bar on top, and one button to go on. **Scratch paper** (and the keypad in practice) sit in the top bar, next to the counter or the timer. Scratch paper comes in two kinds, switched at its top left, and the one used last opens next time: **Canvas** (write with the pen) or **Paper** (a notebook sheet, squared by default, A4 or A5 on a phone: type text and `$maths$`, add a graph or a board, use columns and free placement, pick the font and paper with **Aa**). What is on either is kept per question until the page is closed; it isn't saved to the notebook. Esc while typing only stops typing; the next Esc closes the scratch paper.
- **Enter** checks or moves to the next question; **1–9** pick a choice; **Esc** closes (an end-of-day test is paused, answers and time kept).
- In practice: hint pills open one at a time (**H**); in practice and both tests **D** opens scratch paper over the question (pen and eraser, kept until the page is closed), and in practice the keypad button shows a maths keypad. A bar rises from the bottom with the verdict.
- When a test is submitted, the score shows as a ring with the pass mark on it; **Review answers** lists every question with the right answer.
- A Khan unit in a study task is a numbered path of its videos and exercises. **Up next** starts the first step not done yet (an exercise is done when mastered, a video when watched to the end; which videos were watched is kept in this browser).

## Notebook

**Notes** in the side bar. Two kinds of page:
- **Topic**: next to the title, name the unit or test topic the page is about (suggestions come from the plan's units and from test topics). A task of that unit lists the page under **Your notes on …** (and can start one), and Progress links it from the topic's row.
- **Page**: a sheet of paper with the title at the top and blocks under it. Click anywhere on the paper to write; the toolbar centred at the bottom of the screen (as on a canvas) puts text, a graph or a picture **anywhere on the sheet**: click **Text**, **Graph**, **Diagram** or **Image** and then click the spot (an outline shows where it lands; Esc cancels), or drag the button straight onto the spot. It lands in front of everything and nothing else on the page moves. The **+** between two blocks inserts into the flow there (Enter on a focused toolbar button adds to the end). Drag a block by the grip at its left to move it (or focus the grip and press Up / Down). Clicking empty paper (the margins, beside or between blocks, under the writing) leaves the block you are in: it stops editing the text, or drops the selection. Text blocks are Markdown with `$inline$` and `$$display$$` LaTeX (KaTeX), tables and lists; the toolbar writes the syntax for you (Ctrl+B, Ctrl+I, Ctrl+M for maths). Graph blocks work like Desmos (see below). Image blocks take a file, a paste or a drop. (Boards placed in pages before still work; new ones go on a canvas page.) Code in backticks or a ```` ``` ```` fence shows as a code block (monospace, kept spaces, sideways scroll, colours for Python and C, a Copy button); the same goes for code in the coach's replies.
- **Paper size**: the selector above the sheet picks **A5, A4, A3, A2, A1, Letter** or **Legal**, and the button next to it turns the page (portrait / landscape). A4 portrait is the default, and pages made before keep it. The sheet has the paper's real proportions (96 px per inch) and is scaled down to fit the window, on a phone too. When the writing runs past one sheet the page grows by whole sheets, with a dashed line and the page number where each new one starts. The writing flows across that line (blocks are not split or pushed to the next sheet). The size is saved with the page.
- **Layout: flow, columns and free placement**, mixed on the same page as you like:
  - *Flow*: blocks follow each other down the sheet, and when one grows the ones under it move down.
  - *Columns*: drag a block (by its grip, or a picture or graph by itself) onto the left or right edge of another block: they sit side by side (up to 4). Drag the line between two columns to share the width differently (double-click it for equal widths). Drag a block out between two lines to take it out of the row.
  - *Free*: any block can be taken out of the flow (**Place freely on the page**: the move icon in its grip column or in a picture's or graph's toolbar). It stays where it was and can then be dragged anywhere on the sheet, margins included, and sized from its sides (pictures and graphs from every side and corner). **Double-click empty paper** to start a text right there. **Back into the flow** puts it back in the flow at the height where it was. A free text moves by dragging the text itself (a click still edits it). While you drag or resize a free block it snaps (with a thin guide line) to the page's centre, the edges of the writing column and the edges and centres of the other blocks; a side being resized snaps the same way. Hold Alt to do either without snapping. The hint under the writing hides where a free block sits on its line. A free block sits in front of the writing and moves nothing. Its **In front of the text / Text flows around it** button makes the writing make room for it instead: the writing in the flow then runs beside it line by line (on the wider side; under it when neither side has room for a line), and pictures, graphs and boards in the flow move down below it. The sheet grows by whole pages to hold free blocks.
  - All of it is saved with the blocks (`row`, `span`, `free: {x, y, w, h, wrap}`; `wrap: true` only when the writing makes room for it).
- **Columns on the page**: the columns button in the page bar turns the whole page into a grid of 1 to 4 columns. The blocks fill it left to right, then the next line (text | text | graph / picture | text | …). Drag a block onto the middle of another to swap them, or to the front or back of one to put it there. One column is the plain flow again; rows you made by hand stay as they were.
- **A text's own style**: the **Aa** button beside a text (in its grip column, or in a free note's bar) sets that text's font (the page's, or serif, sans, handwriting, neat handwriting), its size (small, normal, large, very large), its alignment (left, centre, right, justified) and its colour (the page's ink, **Muted** grey for side notes and captions, or the **Accent**; saved as `tone`). What isn't set comes from the page.
- **The pen**: **Pen** in the toolbar at the bottom puts the pen in your hand: write and draw straight on the sheet, anywhere, over the writing, graphs and pictures too, like on paper. The toolbar then holds the pen, the eraser (it takes away a whole line), four colours (the first one follows the theme), the pen size, undo (also Ctrl+Z) and **Done** (or Esc). The ink is saved with the page (`ink`) and the sheet grows to hold it. Scratch paper's paper kind has the pen too.
- **Font and paper**: the **Aa** button above the sheet picks the font of the page (**Serif**, **Sans**, **Handwriting** (Caveat) or **Neat handwriting** (Patrick Hand); both handwriting fonts have the Turkish letters) and the paper (**Plain**, **Squared** with 5 mm squares, or **Dotted**). **A line under each heading** draws a thin rule under every heading on the page (`rules`). Maths and code keep their own type. Saved with the page.
- **Pictures and graphs on a page**: click one to select it. A frame appears with handles on the four sides and four corners, and a small toolbar on top of it.
  - Corner handles keep the proportions; hold **Shift** to change them.
  - Side handles stretch one way only. A picture whose proportions were changed is cropped to its frame by default; the toolbar switches to **Fit** (whole picture, with room around it) or **Stretch**.
  - Every handle follows the pointer one to one, with the size shown while you drag (at least 80 × 60, at most the text column's width).
  - Drag the picture or graph itself to move it: sideways it moves within the column (it snaps to the left, the centre and the right), and up or down past other blocks it changes places, with a line showing where it will land.
  - The toolbar has **Align left / Centre / Align right**, **Reset size** (back to the default size, centred) and **Delete**; a graph's toolbar also has **Edit**.
  - **Esc** or a click on empty paper deselects; **Delete** removes the selected block.
  - Text doesn't flow around a picture; to put text next to one, make two columns, or place either of them freely.
  - Size, place and fit are saved with the block (`width`, `height`, `x`/`align`, `fit`).
- **Canvas**: one big board. Double-click for a text card, add graphs and pictures (drag any card, graphs included, to move it; the corner handle resizes), drag from one card to another with the arrow tool (double-click an arrow to label it), write with the pen. Ctrl+Z / Ctrl+Shift+Z, Ctrl+D duplicates, Space or the hand tool pans, Ctrl+wheel zooms.

**Diagrams.** A diagram block is a drawing written line by line, in 3D or flat, for figures a graph can't draw (a stress cube, a free-body sketch, vectors on a plane). Double-click it (or **Edit**) for its lines and a large live drawing; drag the drawing to turn it (Shift keeps it level), or pick **3D** or **Flat** (x right, y up, like paper). The view is saved with the block (`cam`). A line that can't be read is listed with its reason, and flagged on the page. One shape per line:
- `box (0,0,0) (2,2,2) blue`: a box between two opposite corners, tinted glass, its hidden edges dashed (`opaque` hides them)
- `arrow (2,1,1) (3,1,1) blue "$\sigma_{11}$" e`: an arrow with a label at its tip; `line (0,0) (1,1) (2,0) dashed`: a line through points (a label sits at its middle); `(x, y)` is `(x, y, 0)`
- `poly (0,0,0) (1,0,0) (0,1,0) green`: a filled polygon; `point (1,1,1) "A" ne`: a labelled dot; `text (1,1,1) "words"`: the words alone
- `axes (-2,0,0) 1`: the x₁ x₂ x₃ arrows from a point (other names may follow in quotes)
- `a = 2`: a number for the lines below, so `(a, 0, a/2)` works; numbers can be expressions (`sqrt(2)/2`, `pi/4`)
- colours `blue red green orange purple ink gray`, and `dashed thin thick nofill opaque`; label sides `n ne e se s sw w nw c`; `#` starts a comment
- An arrow or dot on a face of a box that faces you shows over it; one on a hidden face shows through the glass. **What can be drawn** in the editor lists all this and loads a worked example (the stress on a cube).

**Graphs.** On a page or a canvas a graph shows only the plot. The palette button in a graph's toolbar sets how it looks: **Grid**, **Axes**, **Numbers** and **Frame** (the border, rounded corners and background) can each be turned off (**Only the curves** turns them all off), **Arrows on the axes** puts arrowheads at their ends, the **x / y axis name** fields name the axes (`$\sigma$`, `$\tau$`), and **Hand-drawn** draws the lines a little unsteady, the curves with a second pencil-like pass and the numbers in handwriting. Saved with the graph (`look`: `arrows`, `xName`, `yName` among them). Dragging it moves the graph; to pan the plot itself hold **Alt** while dragging (the toolbar says so), and the **+ / − / reset** buttons zoom. **Edit** (on hover or in the toolbar) or a double click opens its formulas in a window, with a large live plot; a line that can't be drawn is flagged on the plot ("1 line needs a fix"). A graph starts with `y = x^2` as an example; change it or add lines (Enter adds one, Backspace on an empty line removes it, the colour dot hides a line). Each line is checked as you type and says what's wrong when it can't be drawn ("“b” isn't defined yet" with an **Add a slider** button, "The expression ends too early"). What it understands:
- `y = 2x + 1`, `sin(x)`, `x = y^2`, `x = 3`: curves; `x^2 + y^2 = 9`: any equation in x and y; `y > x^2 - 4`, `x^2 + y^2 <= 9`: shaded regions (dashed edge when strict)
- `a = 2`: a slider; any one-letter name (`a`, `k_1`) can be used in other lines
- `f(x) = x^3/10` then `y = f(x) + 1`: your own functions
- `(1, 2)`: a point; `2^10`: shows its value
- `(80, 30) "X"`: a labelled point (text between `$` signs is maths: `"$X(\sigma_x, \tau_{xy})$"`). A word after the label says where it sits: `n ne e se s sw w nw` (`ne` by default); `c` shows the label alone, centred on the spot, without the point
- `segment((80, 30), (20, -30))`: a segment between two points; a label after it sits at its middle
- `y = 2x + 1 {0 < x < 3}`, `y = x^2 {x > 0, y < 4}`, `y > x {x < 1}`: a curve or region drawn only where the braces hold; it ends exactly at the edge
- `(50 + 12cos(t), 12sin(t)) {0 < t < 0.8}`: a curve drawn by `t` (0 to 1 unless the braces say otherwise), for arcs and spirals
- functions: `sin cos tan asin acos atan sqrt abs |x| ln log exp floor ceil`, constants `pi e`

Pages save themselves a moment after you stop typing. A new page left empty is removed when you leave it (and an empty page more than 5 minutes old is cleared from the list). They live in the database (`notes_pages`); pictures are files in `backend/data/notes/` next to it. **Database backups don't include those pictures**: copy the folder too.

## XP and streak

The lightning counter in the top bar is XP, worked out from what the database already records, so nothing extra is stored and nothing can drift: a task done 20, a Khan question right on the first try without hints 5 (any other first answer 1), an exercise mastered 25, each right answer in an end-of-day test 10, a Khan unit test passed 100 (taken but not passed 20), a closed day 30. Levels get longer as they go (100, 200, 300 … XP). Click the counter for the level, the last 7 days and the latest gains. The flame counter is the streak: study days in a row (Thursday and Friday skipped) with at least 30 minutes of tracked work.

## Settings

The avatar menu (top right) has **Profile** and **Settings**. Settings has the theme (**System**, **Light** or **Dark**; System follows the computer and switches with it), the **language** of the interface (**English** or **Türkçe**: menus, buttons and dates; the coach's reply language stays its own setting under Coach), the **accent** colour (deep indigo `#27294C` by default, five other presets or any colour; on the dark theme a dark choice is shown as a lighter tone of the same hue so it stays visible), the **layout** (menu and coach panel each on the left or the right), the coach's settings, the keyboard shortcuts, and the system health panel. The theme, language, accent and layout are kept in this browser.

## Notifications

The app's own messages, no browser pop-ups: a toast at the top right says what happened (errors stay longer; one that leads somewhere opens it when clicked), and the **bell** in the top bar keeps the history in the database (`notices`, last 500). Sticking points from one go are folded into one ("3 new sticking points", **Show all**), and the same message again while the first is unread moves it to the top instead of adding a row. Mark one or all as read, delete one, or clear all. Questions like "Delete this page?" are the app's own dialog too (Enter confirms, Esc cancels).

## Health panel

The **Settings** page has a **System health** section: API key, paths, repo watcher state, code sandbox, last backup, how many study days of new material each track has left, unfinished closes (with **Retry now**), schema version, and the last files the app wrote. Problems also show as warnings at the top of every page until they're fixed or dismissed.

The repo watcher restarts itself when the study repo folder is deleted, replaced or missing at startup. If it isn't running, exercise tasks have a **Compile now** button.

## Tests

```bash
cd backend && uv run pytest
```

The suite runs against throwaway copies (its own database, repo, `COACH.md`) and covers closing days, carry-over, the cursor, `PROGRESS.md`/`COACH.md`/math log writes, timers, tests, the clock, the request guard, backups, migrations, the watcher, Khan grading, practice and unit tests (against a miniature Kolibri channel), and plans of your own: answer checks, repairing a model draft, draft → change → approve with a stubbed model, unit checks and retakes, switching from the CTU plan, and the API key file. No test calls the real model.

## Layout

```
backend/app/
  main.py         HTTP API, request guard, SSE stream (FastAPI)
  state.py        days, tasks, timers, scores, sticking points, day notes, math log
  planner.py      closing days (in steps), carry-over, new days, PROGRESS.md and COACH.md writes
  monitor.py      repo watcher (compile on save), git polling, idle/overtime, midnight close, retries
  agent.py        coach chat and its tools
  tests_eod.py    end-of-day tests, C quizzes, practice tests
  offline.py      built-in questions for when there is no API key
  codecheck.py    formats and runs model-written code (in bubblewrap when available)
  files.py        atomic rewrites and appends of external files, write log
  health.py       warnings shown in the UI
  notes.py        notebook pages and their pictures
  xp.py           XP and level, derived from recorded work
  khan.py         Khan content through Kolibri: unit outline, downloads, videos, practice, mastery, unit test
  perseus.py      Khan exercise items: what the browser may see, grading (sympy for expressions)
  account.py      the local account: name, picture, GitHub choice
  backup.py       backup file: export and restore of the whole data folder
  profile.py      the active plan's frame (days, blocks, pass marks, goals, plan-specific prompt text)
  presets/ctu.py  the CTU plan as a preset (plain data)
  prompts.py      coach, planner and test prompts assembled from the active plan
  onboarding.py   plan setup: answers, the model's draft and its repair, changes, approval
  tracks.py       running a plan of your own: units, sessions, unit checks, retakes, runway, progress
  planlog.py      PLAN.md and the plan's log
  keys.py         the API key kept in the data folder
  curriculum.py   Khan/Beej/Kintsugi material and its order, next phases, runway estimate
  seed.py         Week 0
  db.py           SQLite schema, transactions, migrations, backups
backend/data/     plan.txt (text of the plan PDF); on installs from before the data folder also ctu.db, backups/, notes/, coach/
backend/tests/    pytest suite; golden/ holds the CTU plan snapshot
frontend/src/     React UI (Setup.tsx: plan setup)
run.sh, run.ps1   start the app (Linux/macOS, Windows); install.sh: one-time setup; package.sh: the package for friends
```
