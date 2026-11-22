# Waymark

A study app for university-level learners: you describe what you study and when, the model drafts a plan (tracks of units, a weekly schedule, pass marks), you approve it, and the app runs your days: tasks with their sources, a timer, closed-book unit checks, an end-of-day test and a coach that helps without solving your work for you.

Everything stays on your computer. You bring your own Anthropic API key.

## Install

1. Install **uv** once (it brings the right Python by itself):
   - Linux / macOS: `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
2. Unpack this folder somewhere you keep programs.
3. Start it:
   - Linux / macOS: `./install.sh` once (on Linux it also adds Waymark to the applications menu), then `./run.sh --open`
   - Windows: right-click `run.ps1` → *Run with PowerShell* (or `powershell -ExecutionPolicy Bypass -File run.ps1`)
4. The browser opens on http://localhost:8723. Add your API key (get one at https://console.anthropic.com/settings/keys), answer the questions, read the draft, ask for changes until it fits, approve it.

The first start downloads Python and the app's packages (a minute or two). After that it starts in seconds.

## Your data

Your plan, days, tests, notes and pictures are in one folder, apart from the app:

- Linux: `~/.local/share/waymark` · macOS: `~/.local/share/waymark` · Windows: `%APPDATA%\Waymark`

Deleting or updating the app doesn't touch it. **Settings → Data → Download a backup** puts everything into one file; restoring it on another computer brings it all back. Your API key is kept in that folder too (`api-key`, readable only by you) and is never put into a backup file.

The plan itself is also written to `PLAN.md` in the data folder, so you can read or share it as a plain file. It is rewritten by the app; change the plan in **Settings → Plan**.

## Updating

Unpack the new version next to the old one (or over it) and start it. Your data folder stays where it is; the database is upgraded on the first start and a copy of the old one is kept in `backups/`.

## Options

Optional settings go into a `.env` file next to `run.sh` (copy `.env.example`). The ones you are likely to want:

- `PORT=8725 ./run.sh` – another port, if 8723 is taken
- `CTU_MODEL` – the model that plans and writes tests (default: Claude Sonnet)
- `CTU_DATA_DIR` – a different data folder (for example on a synced drive)
- `CTU_STUDY_REPO` – a folder with your own work (a git repo); the app then watches it and records your commits

---

## Türkçe kısa özet

1. **uv**'yi bir kere kur (yukarıdaki komut).
2. Klasörü aç; Linux/macOS'ta önce `./install.sh`, sonra `./run.sh --open`; Windows'ta `run.ps1` dosyasına sağ tık → *PowerShell ile çalıştır*.
3. Tarayıcıda API anahtarını gir, soruları cevapla, taslağı oku, değişiklik iste, onayla.

Verilerin uygulamadan ayrı bir klasörde durur (Linux/macOS `~/.local/share/waymark`, Windows `%APPDATA%\Waymark`). **Ayarlar → Veri → Yedeği indir** her şeyi tek dosyaya koyar; API anahtarın yedeğe girmez.
