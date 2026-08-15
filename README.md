# Suno Downloader

Download all your songs from Suno as MP3, WAV, and MIDI with one paste into the browser console. No installs, no servers, no account credentials shared with anyone — everything runs locally in your own browser.

## Features

- **Downloads your full Suno library + workspace** (auto-detected via Suno's own feed)
- **MP3 and/or WAV and/or MIDI** — tick whichever you want (WAV/MIDI use Suno's converters, so they're slower per song)
- **Stems support** — optionally download your already-generated stems into each song's `stems/` folder (`Vocals.mp3`, `Drums.mp3`, ...); repeated generations get a short clip ID so none overwrite each other
- **Section-edit clips grouped** — Suno's "replace section" variations (e.g. `[01:55.0 - 02:18.4] {verse]`) are filed under their parent song's `variations/` folder
- **Per-song folders** — one unique folder per song (`<title> [<id>]/`), so duplicate titles never collide
- **Resumable** — stop any time and rerun to continue where you left off; already-downloaded files are skipped
- **One-time scan** — a cache file (`suno-cache.json`) remembers your song list, so reruns are instant
- **Zero installs** — just a script pasted into DevTools

## How to use

1. Open <https://suno.com> and make sure you're logged in.

2. Press `F12` on Windows/Linux (or `Cmd + Option + I` on Mac) to open the browser's developer tools.

3. Look for a row of tabs near the top of the developer tools panel (Elements, Console, Sources, Network, ...). Click the **Console** tab.

4. Click once anywhere inside the console area (the big blank box at the bottom) so it has focus.

5. Paste the entire contents of [`suno-console-download.js`](suno-console-download.js).

   > **If pasting doesn't work / is greyed out:** Chrome sometimes requires you to type `allow pasting` first. Just type `allow pasting` (no quotes) into the console and press Enter, then paste again. This is a built-in Chrome safety feature — nothing to do with this tool.

6. Press **Enter** to run it.

7. A small panel appears. Tick the formats you want:
   - **MP3** — fast, works for every song
   - **WAV** — Suno converts each song first, so this is slower (a few seconds to ~30s per song)
   - **MIDI** — Suno converts each song to note data (slowest, ~1-2 min per song). **Uses your account credits.**
   - **Include stems** — also downloads your existing stems (only if you have them). Stems must have been generated in Suno first (click "Get stems" on a song in Suno, which costs credits) — this tool only *downloads* stems that already exist, it never generates them.

> **Warning: WAV and MIDI conversion can eat your credits quickly.** Both depend on Suno's on-demand converters, which consume account credits per conversion. With a large library the conversions can add up fast — e.g. converting a few hundred songs may drain a 10,000-credit Premier balance. MP3 downloads and already-existing stem downloads are free; watch your remaining balance (shown in Suno's sidebar) while a run is in progress, and rerun after credits refresh to grab anything that was skipped.

8. Click **Choose folder...** and pick where to save your songs.

9. Click **Start**.

> Chrome or Edge is required for the folder picker. On Firefox/Safari it falls back to normal per-file downloads.

## What you get

```
<your chosen folder>/
  My Song [a1b2c3d4]/
    My Song.mp3
    My Song.wav
    My Song.mid
    stems/
      Vocals.mp3
      Vocals [f6e7d8c9].mp3       (when the same stem was generated more than once)
      Drums.mp3
      Bass.mp3
      ...
    variations/
      [01:55.0 - 02:18.4] {verse].mp3   (section-edit clips, grouped under their parent song)
  Another Song [e5f6a7b8]/
    ...
  suno-cache.json          (auto-created; lets reruns skip the slow re-scan)
```

## Resuming and re-scanning

- **Rerun to resume** — the script skips songs that are already downloaded, so a stopped run picks up exactly where it left off.
- **Re-scan for new songs** — if you've created songs since your last scan, click the "Re-scan for new songs" link. It only scans forward until it hits songs you've already seen, so it's fast even for large libraries.

## First scan takes a few minutes

Suno's feed returns your songs mixed in with a lot of generated stems, and there's no way to filter them out server-side. The first scan walks through all of them once to find your real songs. The progress panel shows how many clips it has scanned, so don't worry if it sits at "found 0 songs" for a while — that's just it grinding through stems, which are skipped automatically.

The scan runs only once; `suno-cache.json` saves the result and every later run is instant.

## Notes on usage

- Songs downloaded with this tool may not be eligible for your commercial use. It is **your responsibility** to follow Suno's Terms of Service and any applicable license terms for the music you download.
- This project is not affiliated with, endorsed by, or connected to Suno. It is an independent, personal-use tool that talks to the same public API the Suno web app uses, from your own logged-in browser session.
- No credentials ever leave your browser. The script only uses your existing session; nothing is sent to anyone but Suno.

## Requirements

- A Suno account (free or paid)
- Chrome or Edge (or any browser with DevTools)
- An internet connection

## Disclaimer

This software is provided "as is", without warranty of any kind. You are solely responsible for how you use it and for complying with the terms of service of any third-party services involved.
