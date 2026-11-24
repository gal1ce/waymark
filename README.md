<p align="center"><img src="packaging/icon.png" width="96" alt=""></p>

<h1 align="center">Waymark</h1>

<p align="center">A study planner that runs your days: you say what you're studying and by when, it drafts a plan, and then it walks you through each day.</p>

<p align="center"><a href="https://github.com/gal1ce/waymark/releases/latest"><b>Download</b></a> · Windows · macOS · Linux · free and open source</p>

---

## What it does

- **Drafts a plan with you.** Answer a few questions: what you study, your goal and its date, which days and how many hours. An AI model drafts a plan of units, a weekly schedule and pass marks. You read it, ask for changes until it fits, and approve it.
- **Runs each day.** Today's tasks come with their sources and a timer. When the day is over, it is closed and the next days are planned. Units you don't pass come back as review.
- **Checks what you learned.** A closed-book check at the end of each unit, and a short test at the end of each day, graded for you.
- **A coach that doesn't do your work.** Ask about whatever is on the screen. The coach knows your plan and your results, and gives hints instead of answers.
- **A notebook.** Pages with Markdown and LaTeX maths, function graphs, diagrams and pictures, and boards for writing by hand.
- **Progress.** Time spent, units passed, a streak and XP, so you can see your progress as you go.

It works in English and Turkish, with a light theme and a dark theme.

## Get it

Download the file for your computer from **[Releases](https://github.com/gal1ce/waymark/releases/latest)**:

| Computer | File | First start |
|---|---|---|
| Windows | `Waymark-…-windows.exe` | Double-click it. If Windows says *Windows protected your PC*, click *More info* → *Run anyway*. |
| Mac with Apple silicon (M1 and newer) | `Waymark-…-macos-arm64.dmg` | Open it and drag Waymark to Applications. The first time macOS refuses it: open *System Settings → Privacy & Security*, scroll down, *Open Anyway*. |
| Intel Mac | `Waymark-…-macos-x86_64.dmg` | Same as above. |
| Linux | `waymark-…-linux-x86_64` | Make it executable (`chmod +x`) and start it. It adds itself to the applications menu. |

Windows and macOS show that warning because the app isn't signed (signing costs money every year). You only have to do it once.

Waymark opens in your browser. Starting it again while it runs opens another tab (on a Mac, click its Dock icon). Close the tabs and it stops on its own after 15 minutes. On a Mac, you can also quit it from the Dock.

## First start

1. **Add an AI provider.** The plan drafts, the tests and the coach need a model. Pick one in the app:

   | Provider | Cost |
   |---|---|
   | Gemini, Groq, OpenRouter | free tiers (with limits) |
   | Anthropic (Claude), OpenAI | paid |
   | A model on your own computer (Ollama, LM Studio, llama.cpp) | free, nothing leaves your computer |

   You can add more than one provider and set the order they are tried in.
2. **Answer the questions.** Choose the quick start (a few questions) or the full set.
3. **Read the draft.** Ask for changes in your own words until it fits, then approve it. From then on, the Today page is where you study.

## Your data

Everything stays on your computer, in one folder:

- Windows: `%APPDATA%\Waymark`
- macOS and Linux: `~/.local/share/waymark`

This folder holds your plan, days, tests, notes, pictures and your AI keys. There is no account and no server of ours. The only things that leave your computer are what you send to the AI provider you chose, and the update check described below.

**Settings → Data → Download a backup** puts everything into one file (without your keys). Restoring that file on another computer brings it all back. Deleting or updating the app doesn't touch the data folder.

## Updates

When you open Waymark and a newer version is out, it shows a screen saying so:

- **Update now:** downloads the new version, checks it, swaps it in and restarts. The tab reloads by itself.
- **Not now:** asks again the next time you open Waymark.
- **Download it myself** and **Skip this version** are there too.

To find out, it asks GitHub for the latest version, at most every few hours, and sends nothing about you. You can turn this off in **Settings → Updates**.

## From source

Running from source, the folder install with `uv`, the configuration options and how everything works inside:

- [INSTALL.md](INSTALL.md): installing from the folder, the options in `.env`
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): architecture, the plan engine, data files, tests, building the packaged app and releasing

---

<details>
<summary><b>Türkçe</b></summary>

**Waymark**, günlerini yöneten bir çalışma planlayıcısı. Ne çalıştığını ve ne zamana kadar bitirmen gerektiğini söylüyorsun, o bir plan taslağı hazırlıyor, sonra her gününü adım adım yürütüyor: görevler ve kaynakları, zamanlayıcı, ünite sonu kapalı kitap kontrolleri, gün sonu testi, senin yerine çözmeyen bir koç ve bir defter.

**İndir:** [Releases](https://github.com/gal1ce/waymark/releases/latest) sayfasından bilgisayarına uygun dosyayı al.
- **Windows:** `.exe` dosyasına çift tıkla. Uyarı çıkarsa *Ek bilgi → Yine de çalıştır*.
- **Mac:** `.dmg` dosyasını aç, Waymark'ı Uygulamalar'a sürükle. İlk açılışta engellerse *Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç*.
- **Linux:** dosyayı çalıştırılabilir yap (`chmod +x`) ve başlat.

Uygulama tarayıcıda açılır. Sekmeleri kapatınca 15 dakika sonra kendi kapanır.

**İlk açılış:** Bir yapay zekâ sağlayıcısı ekle. Gemini, Groq ve OpenRouter'ın ücretsiz kotası var; bilgisayarındaki yerel bir modeli de kullanabilirsin. Sonra soruları cevapla, taslağı oku, istediğin değişiklikleri iste ve onayla.

**Verilerin** bilgisayarında, tek bir klasörde durur: Windows'ta `%APPDATA%\Waymark`, macOS ve Linux'ta `~/.local/share/waymark`. Hesap yok, sunucu yok. **Ayarlar → Veri → Yedeği indir** her şeyi tek bir dosyaya koyar.

**Güncellemeler:** Yeni sürüm çıkınca uygulamayı açtığında bir ekran çıkar. *Şimdi güncelle* dersen kendini günceller; *Şimdi değil* dersen bir sonraki açılışta yine sorar.

</details>
