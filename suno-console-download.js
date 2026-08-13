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
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer">
      <input type="checkbox" id="suno-dl-stems"> Include stems
    </label>
    <button id="suno-dl-pick" style="width:100%;padding:8px;margin-bottom:6px;border:0;border-radius:6px;background:#444;color:#fff;font-weight:600;cursor:pointer">Choose folder...</button>
    <button id="suno-dl-btn" style="width:100%;padding:8px;border:0;border-radius:6px;background:#ff6b9d;color:#fff;font-weight:600;cursor:pointer">Start</button>
    <div id="suno-dl-status" style="margin-top:10px;white-space:pre-wrap;word-break:break-all"></div>`;
  document.body.appendChild(panel);
  const btn = panel.querySelector("#suno-dl-btn");
  const pickBtn = panel.querySelector("#suno-dl-pick");
  const status = panel.querySelector("#suno-dl-status");
  const mp3Check = panel.querySelector("#suno-dl-mp3");
  const wavCheck = panel.querySelector("#suno-dl-wav");
  const stemsCheck = panel.querySelector("#suno-dl-stems");
  const setStatus = (t) => (status.textContent = t);
  const includeStems = () => stemsCheck.checked || INCLUDE_STEMS;
  const getFormats = () => ({
    mp3: mp3Check.checked || FORMAT === "mp3" || FORMAT === "both",
    wav: wavCheck.checked || FORMAT === "wav" || FORMAT === "both",
  });

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

  // folder for a song is always unique: "<title> [<id8>]"
  const folderFor = (e) => sanitize(e.title) + " [" + e.id.slice(0, 8) + "]";

  async function download(entry, dir) {
    const { id, title, isStem, parentId, stemName } = entry;
    const clean = sanitize(title);
    const fmt = getFormats();
    // stems go into <parent song folder>/stems/, named by stem group (Vocals, Drums, ...)
    if (isStem && dir) {
      const parentEntry = scanState.songs.get(parentId);
      const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : clean);
      const stemsDir = await getOrCreateSubDir(parentFolder, "stems");
      const fname = stemName || clean;
      const results = [];
      if (fmt.mp3) {
        if (await existsInFolder(stemsDir, fname + ".mp3")) results.push("mp3:skip");
        else {
          const blob = await (await fetch(`https://cdn1.suno.ai/${id}.mp3`)).blob();
          await saveToFolder(stemsDir, fname + ".mp3", blob);
          results.push("mp3");
        }
      }
      if (fmt.wav) {
        if (await existsInFolder(stemsDir, fname + ".wav")) results.push("wav:skip");
        else {
          const url = await getWavUrl(id);
          const blob = await (await fetch(url)).blob();
          await saveToFolder(stemsDir, fname + ".wav", blob);
          results.push("wav");
        }
      }
      return results.join("+");
    }
    const songDir = await getOrCreateSubDir(dir, folderFor(entry));
    const results = [];
    if (fmt.mp3) {
      if (dir && await existsInFolder(songDir, clean + ".mp3")) results.push("mp3:skip");
      else {
        const blob = await (await fetch(`https://cdn1.suno.ai/${id}.mp3`)).blob();
        if (songDir) await saveToFolder(songDir, clean + ".mp3", blob); else saveViaDownload(clean + ".mp3", blob);
        results.push("mp3");
      }
    }
    if (fmt.wav) {
      if (dir && await existsInFolder(songDir, clean + ".wav")) results.push("wav:skip");
      else {
        const url = await getWavUrl(id);
        const blob = await (await fetch(url)).blob();
        if (songDir) await saveToFolder(songDir, clean + ".wav", blob); else saveViaDownload(clean + ".wav", blob);
        results.push("wav");
      }
    }
    return results.join("+");
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
    if (cached && !rescan && cached.libDone && cached.wsDone) {
      songs = cached.songs;
      setStatus(`Using cache: ${songs.length} songs.\nPress Start to download.`);
      return true;
    }
    stopRequested = false;
    restoreScanState(cached);
    const { songs: fresh } = await enumerateSongs(dir);
    if (stopRequested) { setStatus("Scan stopped. Progress saved - rerun to resume."); return false; }
    songs = fresh;
    if (!songs.length) { setStatus("No songs found."); return false; }
    setStatus(`Found ${songs.length} songs.\nPress Start to download.`);
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
        const got = await download(e, dir);
        if (got.includes("skip")) skipped++;
        else ok++;
        setStatus(`[${i + 1}/${songs.length}] ${got}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
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
        restoreScanState(cached);
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
})();
