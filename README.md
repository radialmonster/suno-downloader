# Suno Downloader

Download all your songs from Suno as MP3, WAV, and MIDI with one paste into the browser console. No installs, no servers, no account credentials shared with anyone — everything runs locally in your own browser.

## Features

- **Downloads your full Suno library + workspace** (auto-detected via Suno's own feed)
- **MP3 and/or WAV and/or MIDI** — tick whichever you want (missing WAV files and MIDI data may require Suno's converters, so they're slower per song)
- **Stems support** — optionally download your already-generated stems as MP3s into each song's `stems/` folder (`Vocals.mp3`, `Drums.mp3`, ...), regardless of the full-song format selection; repeated names get stable clip-ID suffixes as needed so none overwrite each other or change names on later re-scans
- **Section-edit clips grouped** — Suno's "replace section" variations (e.g. `[01:55.0 - 02:18.4] {verse]`) are filed under their parent song's `variations/` folder
- **Per-song folders** — one unique folder per song (`<title> [<id>]/`), so duplicate titles never collide; unsafe or overlong filename characters are normalized for portability (with the Chrome/Edge folder picker)
- **Resumable folder downloads** — stop any time and rerun to continue where you left off; already-downloaded files are skipped
- **One-time folder scan** — a cache file (`suno-cache.json`) remembers your song list, so reruns are instant
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
   - **WAV** — downloads an existing WAV directly; if none exists, Suno may need to convert it first
   - **MIDI** — Suno converts each song to note data (slowest, ~1-2 min per song). **Uses your account credits.**
   - **Include stems** — also downloads your existing stems (only if you have them). Stems must have been generated in Suno first (click "Get stems" on a song in Suno, which costs credits) — this tool only *downloads* stems that already exist, it never generates them.

> **Conversion warning:** MIDI conversion may use account credits. For WAV, the downloader first checks for an existing file and downloads it directly; only a missing WAV triggers a conversion request. Suno's general WAV billing policy is not assumed here, so compare the displayed credit balance before and after a bounded run if that matters to you. This downloader never generates songs or stems.

8. Click **Choose folder...** and pick where to save your songs.

9. Click **Start**.

> Chrome or Edge is required for the folder picker, per-song folders, cache, and automatic resume/skip behavior. On Firefox/Safari it falls back to normal per-file downloads with stable clip-ID suffixes. Reruns cannot inspect or skip prior downloads, so the browser controls any repeat-download suffixes.

## What you get

```
<your chosen folder>/
  My Song [a1b2c3d4]/
    My Song.mp3
    My Song.wav
    My Song.mid
    stems/
      Vocals [a1b2c3d4].mp3
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

- **Rerun to resume** — the script skips each already-downloaded format file, so a stopped run continues with missing files and newly selected formats.
- **Re-scan for new songs** — if you've created songs since your last scan, click the "Re-scan for new songs" link. Suno's feeds are treated as newest-first, so the downloader stops after a full page of clips it has already seen. Delete `suno-cache.json` before rerunning if you need a guaranteed full rebuild instead of this fast incremental scan.
- **Cache errors are not hidden** — if `suno-cache.json` is unreadable or malformed, the panel reports the problem instead of silently replacing resume state.

## First scan takes a few minutes

Suno's feeds can return your songs mixed in with generated stems. The first scan walks through the returned clips to find your real songs. The progress panel shows how many clips it has scanned, so don't worry if it sits at "found 0 songs" for a while — it may be processing stems, which are skipped automatically unless you enabled them.

After a complete scan, `suno-cache.json` makes unchanged reruns instant. A partial scan, changed feed/stem settings, or an explicit re-scan can require more feed requests.

If you set the source-level `LIMIT` option above zero, the downloader stops requesting subsequent pages once enough eligible download items have been found (a page already in flight from the other feed may still finish). With the folder picker, the partial cursors are cached, so increasing or removing the limit later resumes from that point instead of restarting the feed walk. An explicit re-scan counts newly discovered items toward the limit and places them before older cached items.

## Notes on usage

- Songs downloaded with this tool may not be eligible for your commercial use. It is **your responsibility** to follow Suno's Terms of Service and any applicable license terms for the music you download.
- This project is not affiliated with, endorsed by, or connected to Suno. It is an independent, personal-use tool that talks to the same API endpoints used by the Suno web app, from your own logged-in browser session.
- No credentials ever leave your browser. Authenticated API requests go only to Suno; media downloads use HTTPS audio URLs returned by Suno's feeds (normally Suno's CDN) and do not include your authorization header.

## Requirements

- A Suno account (free or paid)
- Chrome or Edge (or any browser with DevTools)
- An internet connection

## Disclaimer

This software is provided "as is", without warranty of any kind. You are solely responsible for how you use it and for complying with the terms of service of any third-party services involved.
