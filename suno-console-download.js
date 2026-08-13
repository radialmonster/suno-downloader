/**
 * Suno bulk downloader (paste into browser console while logged into suno.com).
 *
 * Downloads all songs from your Library + Workspace as MP3 and/or WAV into a
 * folder of your choice - no per-file save prompts. Each song gets its own
 * sub-folder:
 *
 *   <your folder>/
 *     <title> [id8]/           one unique folder per song (id disambiguates dupes)
 *       <title>.mp3            MP3 download
 *       <title>.wav            WAV download
 *       stems/                 (when stems enabled) Vocals.mp3, Drums.mp3, ...
 *     suno-cache.json          scan cache (auto-created)
 *
 * Usage:
 *   1. Open https://suno.com and make sure you're logged in.
 *   2. Open DevTools (F12) and switch to the Console tab.
 *   3. Adjust FORMAT / LIMIT / INCLUDE below if you want.
 *   4. Paste this whole script and press Enter.
 *   5. A panel appears - click "Choose folder...", pick where to save, done.
 *
 * By default it downloads only full songs (stems are excluded automatically).
 * Set INCLUDE_STEMS = true to also download already-generated stems - these are
 * just re-downloaded, so they cost no credits (only generating stems does).
 *
 * Resumable: rerun any time and it skips songs already present in the folder.
 * The chosen folder gets a suno-cache.json so reruns skip the slow re-enumeration;
 * use the "Re-scan for new songs" link when you've added songs since the last run.
 *
 * Requirements: Chrome or Edge (Chromium). Safari/Firefox lack the folder
 * picker API, so on those browsers it falls back to normal per-file downloads.
 */
void (async () => {
  const FORMAT = "mp3"; // 'mp3', 'wav', or 'both'
  const LIMIT = 0; // 0 = all songs, or N = first N songs
  const INCLUDE_LIBRARY = true; // your Suno library (created + liked songs)
  const INCLUDE_WORKSPACE = true; // your workspace (drafts/in-progress)
  const INCLUDE_STEMS = false; // also download already-generated stems (no credits needed)
  const PAUSE_MS = 1500; // delay between songs (be polite to the API)

  const API = "https://studio-api-prod.suno.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sanitize = (name) =>
    name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim() || "untitled";

  // ---------- small floating panel ----------
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
    background: "#1a1a1a", color: "#fff", font: "13px/1.5 system-ui, sans-serif",
    padding: "14px 16px", borderRadius: "10px", boxShadow: "0 4px 24px rgba(0,0,0,.4)",
    width: "260px",
  });
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px">Suno downloader</div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="suno-dl-mp3" checked> MP3
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="suno-dl-wav" checked> WAV (slower, converts each song)
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="suno-dl-midi"> MIDI (uses credits)
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer">
      <input type="checkbox" id="suno-dl-stems"> Include stems (already-generated ones, free)
    </label>
    <div id="suno-dl-credits" style="margin-bottom:8px;padding:8px;border-radius:6px;background:#262626;font-size:12px;white-space:pre-wrap"></div>
    <button id="suno-dl-pick" style="width:100%;padding:8px;margin-bottom:6px;border:0;border-radius:6px;background:#444;color:#fff;font-weight:600;cursor:pointer">Choose folder...</button>
    <button id="suno-dl-btn" style="width:100%;padding:8px;border:0;border-radius:6px;background:#ff6b9d;color:#fff;font-weight:600;cursor:pointer">Start</button>
    <div id="suno-dl-status" style="margin-top:10px;white-space:pre-wrap;word-break:break-all"></div>`;
  document.body.appendChild(panel);
  const btn = panel.querySelector("#suno-dl-btn");
  const pickBtn = panel.querySelector("#suno-dl-pick");
  const status = panel.querySelector("#suno-dl-status");
  const mp3Check = panel.querySelector("#suno-dl-mp3");
  const wavCheck = panel.querySelector("#suno-dl-wav");
  const midiCheck = panel.querySelector("#suno-dl-midi");
  const stemsCheck = panel.querySelector("#suno-dl-stems");
  const creditsBox = panel.querySelector("#suno-dl-credits");
  const setStatus = (t) => (status.textContent = t);
  const includeStems = () => stemsCheck.checked || INCLUDE_STEMS;
  const getFormats = () => ({
    mp3: mp3Check.checked || FORMAT === "mp3" || FORMAT === "both",
    wav: wavCheck.checked || FORMAT === "wav" || FORMAT === "both",
    midi: midiCheck.checked,
  });

  // show current credit balance and estimated cost of the selected options
  async function refreshCredits() {
    const fmt = getFormats();
    let line = "";
    const apiCredits = await api("GET", "/api/billing/credits", null, 1);
    const balance = apiCredits.status === 200 && typeof apiCredits.j.total_credits_left === "number"
      ? apiCredits.j.total_credits_left : null;
    if (balance !== null) {
      line += "Credits left: " + balance + "\n";
      const wav = fmt.wav, midi = fmt.midi, stems = includeStems();
      if (wav || midi || stems) {
        line += "WAV/MIDI conversions use credits - cost varies, watch your balance while running.";
      }
    } else {
      line += "Could not read credit balance.";
    }
    creditsBox.textContent = line;
  }

  // ---------- token / api ----------
  let token = null;
  const headers = async (force) => {
    if (!token || force) {
      token = await window.Clerk.session.getToken();
      if (!token) throw new Error("could not get session token");
    }
    return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  };
  const api = async (method, p, body, retries = 5) => {
    for (let i = 0; i <= retries; i++) {
      const res = await fetch(API + p, {
        method,
        headers: await headers(i > 0),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && i < retries) continue; // token expired -> refresh once
      if (res.status === 429) {
        const wait = Math.min(2000 * Math.pow(2, i), 60000); // exponential: 2s,4s,8s,... max 60s
        setStatus("Rate limited - waiting " + (wait / 1000) + "s...");
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { raw: text }; }
      return { status: res.status, j };
    }
  };

  // ---------- enumeration ----------
  const isStem = (c) => {
    const m = c.metadata || {};
    if (m.stem_from_id || m.stem_task) return true;
    return (m.history || []).some((h) => h.stem_task || h.stem_from_id);
  };

  // infill/section-edit clips (e.g. "[01:55.0 - 02:18.4] {verse]") are variations
  // of a parent clip -> group them under the parent's folder
  const infillParentId = (c) => {
    const m = c.metadata || {};
    if (m.task === "infill") {
      const h = (m.history || []).find((x) => x.type === "concat_infilling" || x.infill);
      if (h && h.id) return h.id;
    }
    return null;
  };

  const stemName = (c) => {
    const m = c.metadata || {};
    const raw = m.stem_type_group_name || "";
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, "_") || null;
  };

  const toEntry = (c) => {
    const e = { id: c.id, title: (c.title || "untitled").trim() };
    if (isStem(c)) {
      e.isStem = true;
      e.parentId = c.metadata?.stem_from_id || null;
      e.stemName = stemName(c);
    } else {
      const p = infillParentId(c);
      if (p) { e.isInfill = true; e.parentId = p; }
    }
    return e;
  };

  let stopRequested = false;
  const stopSleep = async (ms) => {
    for (let waited = 0; waited < ms && !stopRequested; waited += 100) await sleep(100);
  };

  // shared scan state, persisted to the cache file after every page
  const scanState = {
    songs: new Map(),
    seenIds: new Set(),
    libCursor: null,
    wsCursor: null,
    libDone: false,
    wsDone: false,
    scanned: 0,
  };

  // during a re-scan we can stop a feed as soon as a page is 100% already-seen
  // (feeds are newest-first, so anything behind a fully-known page is known too)
  let earlyStop = false;

  const progress = (kind, page) =>
    setStatus(kind + " page " + page +
      " | scanned " + scanState.scanned + " clips, found " + scanState.songs.size + " songs" +
      (scanState.songs.size ? "" : " (mostly stems - will skip them)"));

  async function getLibrary(dir, onProgress, persist) {
    if (!INCLUDE_LIBRARY || scanState.libDone) return;
    let cursor = scanState.libCursor;
    let page = 0;
    do {
      if (stopRequested) break;
      page++;
      progress("Scanning library", page);
      const r = await api("POST", "/api/feed/v3", { n: 50, p: null, client_type: "web", cursor });
      if (r.status !== 200) { setStatus("library feed error " + r.status); break; }
      const clips = r.j.clips || [];
      scanState.scanned += clips.length;
      let known = 0;
      for (const c of clips) {
        if (earlyStop && scanState.seenIds.has(c.id)) known++;
        scanState.seenIds.add(c.id);
        if (c.status === "complete" && (includeStems() || !isStem(c)))
          scanState.songs.set(c.id, toEntry(c));
      }
      cursor = r.j.has_more ? r.j.next_cursor : null;
      scanState.libCursor = cursor;
      if (!cursor) scanState.libDone = true;
      await persist(dir);
      if (earlyStop && clips.length && known === clips.length) {
        scanState.libDone = true;
        scanState.libCursor = null;
        break;
      }
      if (cursor) await stopSleep(700);
    } while (cursor);
  }

  async function getWorkspace(dir, onProgress, persist) {
    if (!INCLUDE_WORKSPACE || scanState.wsDone) return;
    let cursor = scanState.wsCursor;
    let page = 0;
    do {
      if (stopRequested) break;
      page++;
      progress("Scanning workspace", page);
      const qs = cursor ? `?n=50&cursor=${encodeURIComponent(JSON.stringify(cursor))}` : "?n=50";
      const r = await api("GET", "/api/project/feed" + qs);
      if (r.status !== 200) { setStatus("project feed error " + r.status); break; }
      const items = r.j.items || [];
      let scannedThisPage = 0;
      let known = 0;
      for (const it of items) {
        const c = it.clip;
        if (it.type !== "clip" || !c) continue;
        scannedThisPage++;
        if (earlyStop && scanState.seenIds.has(c.id)) known++;
        scanState.seenIds.add(c.id);
        if (c.status === "complete" && (includeStems() || !isStem(c))) {
          scanState.songs.set(c.id, toEntry(c));
        }
      }
      scanState.scanned += scannedThisPage;
      cursor = r.j.next_cursor || null;
      scanState.wsCursor = cursor;
      if (!cursor) scanState.wsDone = true;
      await persist(dir);
      if (earlyStop && items.length && known === items.length) {
        scanState.wsDone = true;
        scanState.wsCursor = null;
        break;
      }
      if (cursor) await stopSleep(700);
    } while (cursor);
  }

  // ---------- saving ----------
  async function getOrCreateSubDir(parent, name) {
    if (!parent) return null;
    try {
      return await parent.getDirectoryHandle(name, { create: true });
    } catch {
      return parent;
    }
  }
  async function saveToFolder(dir, name, blob) {
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
  }

  async function existsInFolder(dir, name) {
    if (!dir) return false;
    try { await dir.getFileHandle(name); return true; } catch { return false; }
  }

  function saveViaDownload(name, blob) {
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  async function getWavUrl(id) {
    let r = await api("GET", `/api/gen/${id}/wav_file/`);
    if (r.j.wav_file_url) return r.j.wav_file_url;
    r = await api("POST", `/api/gen/${id}/convert_wav/`);
    if (r.status >= 400) throw new Error("convert_wav " + r.status);
    for (let n = 0; n < 60; n++) {
      await sleep(5000);
      r = await api("GET", `/api/gen/${id}/wav_file/`);
      if (r.j.wav_file_url) return r.j.wav_file_url;
    }
    throw new Error("wav conversion timed out");
  }

  // MIDI: GET /api/gen/{id}/midi/ returns {"state":"running"} then
  // {"state":"complete","instruments":[{name,is_drum,notes:[{pitch,start,end,velocity}]}]}
  async function getMidiData(id) {
    for (let n = 0; n < 60; n++) {
      const r = await api("GET", `/api/gen/${id}/midi/`);
      if (r.status >= 400) throw new Error("midi " + r.status);
      if (r.j.state === "complete") return r.j;
      await sleep(5000);
    }
    throw new Error("midi conversion timed out");
  }

  // build a standard SMF (type 0) MIDI file from Suno's instrument/note data
  function midiToBlob(data) {
    const PPQ = 480; // ticks per quarter note
    const ticksPerSec = (PPQ * 120) / 60; // assume 120 BPM
    const events = [];
    const ins = data.instruments || [];
    for (let ch = 0; ch < ins.length; ch++) {
      const notes = ins[ch].notes || [];
      for (const n of notes) {
        const vel = Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.7) * 127)));
        const onT = Math.max(0, Math.round((n.start ?? 0) * ticksPerSec));
        const offT = Math.max(onT + 1, Math.round((n.end ?? n.start ?? 0) * ticksPerSec));
        events.push([onT, [0x90 | ch, n.pitch & 127, vel]]);
        events.push([offT, [0x80 | ch, n.pitch & 127, 0]]);
      }
    }
    events.sort((a, b) => a[0] - b[0]);
    const buf = [];
    const vlq = (v) => {
      const b = [v & 0x7f];
      while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80);
      return b;
    };
    buf.push(0x4d, 0x54, 0x68, 0x64); // "MThd"
    buf.push(0, 0, 0, 6);
    buf.push(0, 0); // format 0
    buf.push(0, 1); // 1 track
    buf.push((PPQ >> 8) & 0xff, PPQ & 0xff);
    buf.push(0x4d, 0x54, 0x72, 0x6b); // "MTrk"
    const trackStart = buf.length;
    let last = 0;
    const push = (arr) => { for (const b of arr) buf.push(b & 0xff); };
    push([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]); // tempo 120bpm
    for (const [t, msg] of events) {
      push(vlq(t - last));
      push(msg);
      last = t;
    }
    push(vlq(0));
    push([0xff, 0x2f, 0x00]); // end of track
    const trackLen = buf.length - trackStart;
    const lenB = [0x00, 0x00, 0x00, 0x00];
    for (let i = 0; i < 4; i++) lenB[3 - i] = (trackLen >> (8 * i)) & 0xff;
    buf.splice(trackStart, 0, ...lenB);
    return new Blob([new Uint8Array(buf)], { type: "audio/midi" });
  }

  const saveMidi = async (dir2, id, name) => {
    if (await existsInFolder(dir2, name + ".mid")) return "midi:skip";
    const data = await getMidiData(id);
    const blob = midiToBlob(data);
    await saveToFolder(dir2, name + ".mid", blob);
    return "midi";
  };

  // folder for a song is always unique: "<title> [<id8>]"
  const folderFor = (e) => sanitize(e.title) + " [" + e.id.slice(0, 8) + "]";

  // download() returns { files: "mp3+wav:fail+midi:skip", fails: 1 }
  async function download(entry, dir) {
    const { id, title, isStem, parentId, stemName } = entry;
    const clean = sanitize(title);
    const fmt = getFormats();
    const out = { files: [], fails: 0 };
    const saveMp3 = async (d, name) => {
      if (await existsInFolder(d, name + ".mp3")) out.files.push("mp3:skip");
      else {
        try {
          const blob = await (await fetch(`https://cdn1.suno.ai/${id}.mp3`)).blob();
          await saveToFolder(d, name + ".mp3", blob);
          out.files.push("mp3");
        } catch (e) { out.fails++; out.files.push("mp3:fail"); }
      }
    };
    const saveWav = async (d, name) => {
      if (await existsInFolder(d, name + ".wav")) out.files.push("wav:skip");
      else {
        try {
          const url = await getWavUrl(id);
          const blob = await (await fetch(url)).blob();
          await saveToFolder(d, name + ".wav", blob);
          out.files.push("wav");
        } catch (e) { out.fails++; out.files.push("wav:fail"); }
      }
    };
    const saveMidi = async (d, name) => {
      if (await existsInFolder(d, name + ".mid")) out.files.push("midi:skip");
      else {
        try {
          const data = await getMidiData(id);
          const blob = midiToBlob(data);
          await saveToFolder(d, name + ".mid", blob);
          out.files.push("midi");
        } catch (e) { out.fails++; out.files.push("midi:fail"); }
      }
    };
    if (isStem && dir) {
      const parentEntry = scanState.songs.get(parentId);
      const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : clean);
      const stemsDir = await getOrCreateSubDir(parentFolder, "stems");
      const fname = stemName || clean;
      if (fmt.mp3) await saveMp3(stemsDir, fname);
      if (fmt.wav) await saveWav(stemsDir, fname);
      if (fmt.midi) await saveMidi(stemsDir, fname);
      return out;
    }
    if (entry.isInfill && dir) {
      // section-edit clips (e.g. "[01:55.0 - 02:18.4] {verse]") go under the
      // parent song's folder in a variations/ subfolder
      const parentEntry = scanState.songs.get(parentId);
      const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : clean);
      const varsDir = await getOrCreateSubDir(parentFolder, "variations");
      const fname = clean;
      if (fmt.mp3) await saveMp3(varsDir, fname);
      if (fmt.wav) await saveWav(varsDir, fname);
      if (fmt.midi) await saveMidi(varsDir, fname);
      return out;
    }
    const songDir = await getOrCreateSubDir(dir, folderFor(entry));
    if (fmt.mp3) {
      if (dir && await existsInFolder(songDir, clean + ".mp3")) out.files.push("mp3:skip");
      else if (!dir) {
        try {
          const blob = await (await fetch(`https://cdn1.suno.ai/${id}.mp3`)).blob();
          saveViaDownload(clean + ".mp3", blob);
          out.files.push("mp3");
        } catch (e) { out.fails++; out.files.push("mp3:fail"); }
      } else await saveMp3(songDir, clean);
    }
    if (fmt.wav) {
      if (dir && await existsInFolder(songDir, clean + ".wav")) out.files.push("wav:skip");
      else if (!dir) {
        try {
          const url = await getWavUrl(id);
          const blob = await (await fetch(url)).blob();
          saveViaDownload(clean + ".wav", blob);
          out.files.push("wav");
        } catch (e) { out.fails++; out.files.push("wav:fail"); }
      } else await saveWav(songDir, clean);
    }
    if (fmt.midi) await saveMidi(songDir, clean);
    return out;
  }

  // ---------- cache (suno-cache.json lives in the chosen folder) ----------
  const CACHE_NAME = "suno-cache.json";
  async function readCache(dir) {
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(CACHE_NAME);
      const text = await (await handle.getFile()).text();
      return JSON.parse(text);
    } catch {}
    return null;
  }
  async function persistCache(dir) {
    if (!dir) return;
    try {
      const handle = await dir.getFileHandle(CACHE_NAME, { create: true });
      const w = await handle.createWritable();
      await w.write(JSON.stringify({
        savedAt: Date.now(),
        libCursor: scanState.libCursor,
        wsCursor: scanState.wsCursor,
        libDone: scanState.libDone,
        wsDone: scanState.wsDone,
        songs: [...scanState.songs.values()],
        seenIds: [...scanState.seenIds],
        scanned: scanState.scanned,
      }, null, 2));
      await w.close();
    } catch {}
  }

  function restoreScanState(cached) {
    if (!cached) return;
    scanState.songs = new Map((cached.songs || []).map((s) => [s.id, s]));
    scanState.seenIds = new Set(cached.seenIds || []);
    scanState.libCursor = cached.libCursor ?? null;
    scanState.wsCursor = cached.wsCursor ?? null;
    scanState.libDone = !!cached.libDone;
    scanState.wsDone = !!cached.wsDone;
    scanState.scanned = cached.scanned || 0;
  }

  async function enumerateSongs(dir) {
    setStatus("Enumerating songs...");
    const onProgress = (msg) => setStatus(msg);
    await Promise.all([
      getLibrary(dir, onProgress, persistCache),
      getWorkspace(dir, onProgress, persistCache),
    ]);
    await persistCache(dir);
    const out = [...scanState.songs.values()];
    if (LIMIT > 0) out.splice(LIMIT);
    return { songs: out };
  }

  // ---------- flow ----------
  const usePicker = typeof window.showDirectoryPicker === "function";
  let songs = [];
  let rescan = false;
  let pickedDir = null;

  async function ensureSongs(dir) {
    if (songs.length && !rescan) return true;
    const cached = await readCache(dir);
    const cacheHasStems = (cached?.songs || []).some((s) => s.isStem);
    const needStemRescan = cached && includeStems() && !cacheHasStems;
    if (cached && !rescan && !needStemRescan && cached.libDone && cached.wsDone) {
      songs = cached.songs;
      setStatus(`Using cache: ${songs.length} songs.\nPress Start to download.`);
      return true;
    }
    stopRequested = false;
    earlyStop = false; // stems newly requested -> must walk the full feed once
    restoreScanState(cached);
    if (needStemRescan) {
      // force a full re-walk so stems get collected (done flags from cache would skip it)
      scanState.songs = new Map();
      scanState.seenIds = new Set();
      scanState.libCursor = null;
      scanState.wsCursor = null;
      scanState.libDone = false;
      scanState.wsDone = false;
    }
    const { songs: fresh } = await enumerateSongs(dir);
    if (stopRequested) { setStatus("Scan stopped. Progress saved - rerun to resume."); return false; }
    songs = fresh;
    if (!songs.length) { setStatus("No songs found."); return false; }
    setStatus(`Found ${songs.length} songs (including stems).\nPress Start to download.`);
    return true;
  }

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.style.cssText = "width:100%;padding:6px;margin-top:8px;border:0;border-radius:6px;background:#555;color:#fff;font-weight:600;cursor:pointer";
  stopBtn.disabled = true;
  stopBtn.addEventListener("click", () => { stopRequested = true; });
  panel.appendChild(stopBtn);

  const startBtn = btn;
  const setBusy = (busy) => {
    startBtn.disabled = busy;
    stopBtn.disabled = !busy;
    pickBtn.disabled = busy;
  };

  // choose folder only (does not start)
  pickBtn.addEventListener("click", async () => {
    if (!usePicker) return;
    try { pickedDir = await window.showDirectoryPicker({ mode: "readwrite" }); }
    catch (e) { setStatus("Folder picker cancelled."); return; }
    setStatus("Folder selected. Press Start to download.");
  });

  // start downloads (scans first if no cache)
  startBtn.addEventListener("click", async () => {
    let dir = pickedDir;
    if (!dir && usePicker) {
      try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); }
      catch (e) { setStatus("Folder picker cancelled."); return; }
    }
    setBusy(true);
    if (!(await ensureSongs(dir))) { setBusy(false); return; }
    let ok = 0, failed = 0, skipped = 0;
    for (let i = 0; i < songs.length; i++) {
      if (stopRequested) break;
      const e = songs[i];
      setStatus(`[${i + 1}/${songs.length}] ${e.title}`);
      try {
        const r = await download(e, dir);
        const files = r.files.join("+");
        const wasSkipped = r.files.some((f) => f.endsWith(":skip")) && r.files.every((f) => f.endsWith(":skip"));
        if (wasSkipped) skipped++;
        else if (r.fails > 0) failed++;
        else ok++;
        setStatus(`[${i + 1}/${songs.length}] ${files}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
      } catch (err) {
        failed++;
        setStatus(`[${i + 1}/${songs.length}] FAILED: ${err.message}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
      }
      if (i < songs.length - 1) await sleep(PAUSE_MS);
    }
    setStatus(stopRequested
      ? `Stopped. ${ok} downloaded, ${skipped} skipped, ${failed} failed. Rerun to resume.`
      : `Done. ${ok} downloaded, ${skipped} skipped, ${failed} failed.`);
    setBusy(false);
    startBtn.textContent = stopRequested ? "Resume" : "Done";
    stopRequested = false;
  });

  // small re-scan link so new songs get picked up without deleting the cache
  if (usePicker) {
    const link = document.createElement("a");
    link.textContent = "Re-scan for new songs";
    link.style.cssText = "display:block;margin-top:8px;color:#ff6b9d;cursor:pointer;font-size:12px;text-decoration:underline";
    link.addEventListener("click", async () => {
      rescan = true;
      songs = [];
      stopRequested = false;
      setStatus("Re-scanning...");
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        const cached = await readCache(dir);
        scanState.songs = new Map();
        scanState.seenIds = new Set();
        scanState.libCursor = null;
        scanState.wsCursor = null;
        scanState.libDone = false;
        scanState.wsDone = false;
        earlyStop = true;
        if (cached && cached.songs) {
          // seed from cache so the early-stop boundary knows what's already seen,
          // but keep done flags false so feeds actually re-walk
          for (const s of cached.songs) scanState.songs.set(s.id, s);
          for (const id of cached.seenIds || []) scanState.seenIds.add(id);
        }
        const { songs: fresh } = await enumerateSongs(dir);
        songs = fresh;
        rescan = false;
        earlyStop = false;
        setStatus(`Re-scan complete: ${songs.length} songs.\nClick "Start" to download.`);
      } catch (e) {
        rescan = false;
        earlyStop = false;
        setStatus("Re-scan cancelled: " + e.message);
      }
    });
    panel.appendChild(link);
  }

  for (const cb of [mp3Check, wavCheck, midiCheck, stemsCheck]) {
    cb.addEventListener("change", refreshCredits);
  }
  refreshCredits().catch(() => {});
})();
