# Waymark

A study app for university-level learners: you describe what you study and when, the model drafts a plan (tracks of units, a weekly schedule, pass marks), you approve it, and the app runs your days: tasks with their sources, a timer, closed-book unit checks, an end-of-day test and a coach that helps without solving your work for you.

Everything stays on your computer. You bring your own Anthropic API key.

## Download (easiest)

Get the file for your computer from the **Releases** page (https://github.com/gal1ce/waymark/releases):

- **Windows:** `Waymark-…-windows.exe`. Double-click it. The first time Windows may say *Windows protected your PC*: click *More info* → *Run anyway* (the app isn't signed).
- **Mac:** `…-macos-arm64.dmg` (M1 and newer) or `…-macos-x86_64.dmg` (Intel). Open it, drag Waymark to Applications, start it. The first time macOS refuses it: *System Settings → Privacy & Security*, scroll down, *Open Anyway*.
- **Linux:** `waymark-…-linux-x86_64`. Make it executable (`chmod +x`) and start it; it adds itself to the applications menu.

It opens in your browser. Starting it again while it runs opens another tab (on a Mac: click its Dock icon). Close the tabs and it stops on its own after 15 minutes; on a Mac you can also quit it from the Dock. Nothing else needs installing. Only C exercises need a C compiler (gcc) on the computer.

## Install from the folder (needs uv)

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

Deleting or updating the app doesn't touch it. The downloaded program also keeps its AI keys (`.env`) and its log (`waymark.log`) there. **Settings → Data → Download a backup** puts everything into one file; restoring it on another computer brings it all back. Your API key is kept in that folder too (`api-key`, readable only by you) and is never put into a backup file.

The plan itself is also written to `PLAN.md` in the data folder, so you can read or share it as a plain file. It is rewritten by the app; change the plan in **Settings → Plan**.

## Updating

**The downloaded program updates itself.** When you open it and a newer version is out, it shows a screen saying so: *Update now* downloads it, checks it, swaps it in and restarts (the open tab reloads into the new one, about a second); *Download it myself* opens the release page; *Not now* asks again the next time you open Waymark; *Skip this version* doesn't ask about that one again. To check it asks GitHub for the latest version, at most every few hours; nothing about you is sent. **Settings → Updates** turns that off or checks right away.

**The folder install** (run.sh): unpack the new version next to the old one (or over it) and start it. Your data folder stays where it is; the database is upgraded on the first start and a copy of the old one is kept in `backups/`.

## Options

Optional settings go into a `.env` file next to `run.sh` (copy `.env.example`). The ones you are likely to want:

- `PORT=8725 ./run.sh` – another port, if 8723 is taken
- AI keys – easiest from **Settings → AI providers**, which writes them here. Several keys per provider go on one
  line, comma separated: `GROQ_API_KEYS=key1,key2`. Models are picked in the same place, not in `.env`.
- `CTU_DATA_DIR` – a different data folder (for example on a synced drive)
- `CTU_STUDY_REPO` – a folder with your own work (a git repo); the app then watches it and records your commits

---

## Türkçe kısa özet

**En kolayı:** Releases sayfasından bilgisayarına uygun dosyayı indir (Windows `.exe`, Mac `.dmg`, Linux dosyası), çift tıkla. Tarayıcıda açılır. İlk açılışta Windows "bilinmeyen yayıncı" derse *Ek bilgi → Yine de çalıştır*; Mac engellerse *Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç*. Sekmeleri kapatınca 15 dakika sonra kendi kapanır. Yeni sürüm çıkınca uygulamayı açtığında bir ekran gösterir: *Şimdi güncelle* (kendini günceller), *Kendim indireyim*, *Şimdi değil*.

**Klasörden kurulum:**

1. **uv**'yi bir kere kur (yukarıdaki komut).
2. Klasörü aç; Linux/macOS'ta önce `./install.sh`, sonra `./run.sh --open`; Windows'ta `run.ps1` dosyasına sağ tık → *PowerShell ile çalıştır*.
3. Tarayıcıda API anahtarını gir, soruları cevapla, taslağı oku, değişiklik iste, onayla.

Verilerin uygulamadan ayrı bir klasörde durur (Linux/macOS `~/.local/share/waymark`, Windows `%APPDATA%\Waymark`). **Ayarlar → Veri → Yedeği indir** her şeyi tek dosyaya koyar; API anahtarın yedeğe girmez.
