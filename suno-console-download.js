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
  const INSTANCE_KEY = "__sunoBulkDownloaderInstance";
  const previousInstance = window[INSTANCE_KEY];
  if (previousInstance && typeof previousInstance.destroy === "function") await previousInstance.destroy();
  document.getElementById("suno-bulk-downloader-panel")?.remove();

  const FORMAT = "mp3"; // 'mp3', 'wav', or 'both'
  const LIMIT = 0; // 0 = all songs, or N = first N songs
  const INCLUDE_LIBRARY = true; // your Suno library (created + liked songs)
  const INCLUDE_WORKSPACE = true; // your workspace (drafts/in-progress)
  const INCLUDE_STEMS = false; // also download already-generated stems (no credits needed)
  const PAUSE_MS = 1500; // delay between songs (be polite to the API)

  const API = "https://studio-api-prod.suno.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sanitize = (name) => {
    let clean = String(name ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    if (!clean) clean = "untitled";
    // Windows rejects these basenames even with an extension. Keep ordinary
    // legacy names unchanged, but make unsafe names portable across platforms.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = "_" + clean;
    clean = Array.from(clean).slice(0, 180).join("").replace(/[. ]+$/g, "");
    return clean || "untitled";
  };

  // ---------- small floating panel ----------
  let stopRequested = false;
  let destroyed = false;
  const instanceController = new AbortController();
  let operationController = null;
  const activeFileWrites = new Set();
  const panel = document.createElement("div");
  panel.id = "suno-bulk-downloader-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "16px", right: "16px", zIndex: "2147483647",
    background: "#1a1a1a", color: "#fff", font: "13px/1.5 system-ui, sans-serif",
    padding: "14px 16px", borderRadius: "10px", boxShadow: "0 4px 24px rgba(0,0,0,.4)",
    width: "260px",
  });
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px">Suno downloader</div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="suno-dl-mp3"> MP3
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" id="suno-dl-wav"> WAV (slower, converts each song)
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
  const setStatus = (t) => { if (!destroyed) status.textContent = t; };
  let operationOptions = null;
  const includeStems = () => operationOptions ? operationOptions.includeStems : (stemsCheck.checked || INCLUDE_STEMS);
  mp3Check.checked = FORMAT === "mp3" || FORMAT === "both";
  wavCheck.checked = FORMAT === "wav" || FORMAT === "both";
  const getFormats = () => ({
    mp3: mp3Check.checked,
    wav: wavCheck.checked,
    midi: midiCheck.checked,
  });
  const instance = {
    async destroy() {
      destroyed = true;
      stopRequested = true;
      operationController?.abort();
      instanceController.abort();
      panel.remove();
      // File System Access writes cannot take an AbortSignal. Waiting for the
      // small set already in flight prevents a replacement instance from
      // writing the same file or cache concurrently.
      await Promise.allSettled([...activeFileWrites]);
      if (typeof persistChain !== "undefined") await persistChain.catch(() => {});
    },
  };
  window[INSTANCE_KEY] = instance;

  // show current credit balance and estimated cost of the selected options
  let creditRefreshId = 0;
  async function refreshCredits() {
    const refreshId = ++creditRefreshId;
    const fmt = getFormats();
    let line = "";
    const apiCredits = await api("GET", "/api/billing/credits", null, 1);
    const balance = apiCredits.status === 200 && apiCredits.j && typeof apiCredits.j.total_credits_left === "number"
      ? apiCredits.j.total_credits_left : null;
    if (balance !== null) {
      line += "Credits left: " + balance + "\n";
      if (fmt.wav || fmt.midi) {
        line += "WAV/MIDI conversions use credits - cost varies, watch your balance while running.";
      }
    } else {
      line += "Could not read credit balance.";
    }
    if (!destroyed && refreshId === creditRefreshId) creditsBox.textContent = line;
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
  const api = async (method, p, body, retries = 5, options = {}) => {
    const { retryAmbiguous = true } = options;
    let refreshToken = false;
    for (let i = 0; i <= retries; i++) {
      const signal = operationController?.signal || instanceController.signal;
      if (destroyed || stopRequested || signal.aborted)
        return { status: 0, j: { raw: "request stopped" } };
      let res;
      let timedOut = false;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      signal.addEventListener("abort", abortRequest, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, 30000);
      try {
        res = await fetch(API + p, {
          method,
          headers: await headers(refreshToken),
          body: body ? JSON.stringify(body) : undefined,
          signal: requestController.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        if (!retryAmbiguous || i >= retries) {
          return { status: 0, j: { raw: (timedOut ? "request timed out" : "network request failed") + " after retries: " + (err?.message || err) } };
        }
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        setStatus("Network error - retrying in " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (stopRequested) return { status: 0, j: { raw: "request stopped" } };
        continue;
      }
      refreshToken = false;
      if (res.status === 401 && i < retries) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        refreshToken = true;
        continue;
      } // token expired -> refresh
      if (res.status === 429 && retryAmbiguous && i < retries) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        const wait = Math.min(2000 * Math.pow(2, i), 60000); // exponential: 2s,4s,8s,... max 60s
        setStatus("Rate limited - waiting " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        continue;
      }
      if (res.status >= 500 && res.status <= 599 && retryAmbiguous && i < retries) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        setStatus("Server error " + res.status + " - retrying in " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        continue;
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        if (!retryAmbiguous || i >= retries)
          return { status: 0, j: { raw: (timedOut ? "response timed out" : "response body failed") + " after retries: " + (err?.message || err) } };
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        setStatus("Network error - retrying in " + (wait / 1000) + "s...");
        await stopSleep(wait);
        continue;
      }
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);
      let j;
      try { j = JSON.parse(text); } catch { j = { raw: text }; }
      return { status: res.status, j };
    }
    return { status: 0, j: { raw: "request failed after retries" } };
  };

  // ---------- enumeration ----------
  const isStem = (c) => {
    const m = c.metadata || {};
    if (m.stem_from_id || m.stem_task) return true;
    const history = Array.isArray(m.history) ? m.history : [];
    return history.some((h) => h && (h.stem_task || h.stem_from_id));
  };

  // infill/section-edit clips (e.g. "[01:55.0 - 02:18.4] {verse]") are variations
  // of a parent clip -> group them under the parent's folder
  const infillParentId = (c) => {
    const m = c.metadata || {};
    if (m.task === "infill") {
      const history = Array.isArray(m.history) ? m.history : [];
      const h = history.find((x) => x && (x.type === "concat_infilling" || x.infill));
      if (h && h.id) return h.id;
    }
    return null;
  };

  const stemName = (c) => {
    const m = c.metadata || {};
    const raw = String(m.stem_type_group_name || "");
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, "_") || null;
  };

  const stemParentId = (c) => {
    const m = c.metadata || {};
    if (m.stem_from_id) return m.stem_from_id;
    const history = Array.isArray(m.history) ? m.history : [];
    const historyParent = history.find((h) => h && h.stem_from_id);
    return historyParent ? historyParent.stem_from_id : null;
  };

  const toEntry = (c) => {
    const e = { id: c.id, title: String(c.title || "untitled").trim() };
    if (isStem(c)) {
      e.isStem = true;
      e.parentId = stemParentId(c);
      e.stemName = stemName(c);
    } else {
      const p = infillParentId(c);
      if (p) { e.isInfill = true; e.parentId = p; }
    }
    return e;
  };

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
    stemsIncluded: false,
    scanned: 0,
  };

  // during a re-scan we can stop a feed as soon as a page is 100% already-seen
  // (feeds are newest-first, so anything behind a fully-known page is known too)
  let earlyStop = false;
  // This must remain an immutable snapshot. The library and workspace scans run
  // concurrently, so using their live shared seenIds would let one scan make new
  // clips look old to the other and could stop a feed too early.
  let knownBeforeRescan = new Set();

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
      if (r.status !== 200 && (stopRequested || destroyed)) return;
      if (r.status !== 200)
        throw new Error("library feed error " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      if (!Array.isArray(r.j?.clips) || typeof r.j.has_more !== "boolean" ||
          (r.j.has_more && (r.j.next_cursor === null || r.j.next_cursor === undefined)))
        throw new Error("library feed error: unexpected response shape");
      const clips = r.j.clips;
      scanState.scanned += clips.length;
      let known = 0;
      for (const c of clips) {
        if (!c || typeof c !== "object" || typeof c.id !== "string")
          throw new Error("library feed error: invalid clip entry");
        if (earlyStop && knownBeforeRescan.has(c.id)) known++;
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
      if (r.status !== 200 && (stopRequested || destroyed)) return;
      if (r.status !== 200)
        throw new Error("project feed error " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      if (!Array.isArray(r.j?.items) || !Object.prototype.hasOwnProperty.call(r.j, "next_cursor"))
        throw new Error("project feed error: unexpected response shape");
      const items = r.j.items;
      let scannedThisPage = 0;
      let known = 0;
      for (const it of items) {
        if (!it || typeof it !== "object" || typeof it.type !== "string")
          throw new Error("project feed error: invalid item entry");
        const c = it.clip;
        if (it.type !== "clip" || !c) continue;
        if (typeof c !== "object" || typeof c.id !== "string")
          throw new Error("project feed error: invalid clip entry");
        scannedThisPage++;
        if (earlyStop && knownBeforeRescan.has(c.id)) known++;
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
      if (earlyStop && scannedThisPage && known === scannedThisPage) {
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
    if (destroyed) throw new Error("downloader instance was replaced");
    try {
      return await parent.getDirectoryHandle(name, { create: true });
    } catch (e) {
      throw new Error("could not create sub-folder '" + name + "': " + e.message);
    }
  }
  async function saveToFolder(dir, name, blob) {
    if (destroyed) throw new Error("downloader instance was replaced");
    const handle = await dir.getFileHandle(name, { create: true });
    const write = (async () => {
      let w = null;
      try {
        w = await handle.createWritable();
        await w.write(blob);
        await w.close();
      } catch (err) {
        if (w) try { await w.abort(); } catch {}
        throw err;
      }
    })();
    activeFileWrites.add(write);
    try { await write; } finally { activeFileWrites.delete(write); }
  }

  async function existsInFolder(dir, name) {
    if (!dir) return false;
    try {
      const handle = await dir.getFileHandle(name);
      return (await handle.getFile()).size > 0;
    } catch { return false; }
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

  async function fetchBlob(url) {
    const signal = operationController?.signal || instanceController.signal;
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal.addEventListener("abort", abortRequest, { once: true });
    if (signal.aborted) abortRequest();
    const timeout = setTimeout(() => requestController.abort(), 60000);
    try {
      const res = await fetch(url, { signal: requestController.signal });
      if (!res.ok) throw new Error("HTTP " + res.status + " while fetching " + url);
      const blob = await res.blob();
      const expected = Number(res.headers.get("content-length"));
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (!blob.size || (Number.isFinite(expected) && expected > 0 && blob.size !== expected))
        throw new Error("incomplete response while fetching " + url);
      if (/^(text\/|application\/(?:json|xml))/.test(contentType))
        throw new Error("unexpected " + contentType + " response while fetching " + url);
      return blob;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);
    }
  }

  async function getWavUrl(id) {
    if (!operationOptions?.creditApproved) throw new Error("WAV conversion was not approved");
    let r = await api("GET", `/api/gen/${id}/wav_file/`);
    if (r.status === 200 && r.j && r.j.wav_file_url) return r.j.wav_file_url;
    if (r.status !== 200 && r.status !== 404) throw new Error("wav_file " + r.status);
    // A lost response is ambiguous: Suno may have accepted this paid conversion.
    // Never automatically resubmit it. One retry remains available only for the
    // explicit 401 path, which is known not to have run the conversion.
    r = await api("POST", `/api/gen/${id}/convert_wav/`, null, 1, { retryAmbiguous: false });
    if (r.status < 200 || r.status >= 300) throw new Error("convert_wav " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
    for (let n = 0; n < 60; n++) {
      await stopSleep(5000);
      if (stopRequested) throw new Error("wav conversion stopped");
      r = await api("GET", `/api/gen/${id}/wav_file/`);
      if (r.status === 200 && r.j && r.j.wav_file_url) return r.j.wav_file_url;
      if (r.status !== 200 && r.status !== 404) throw new Error("wav_file " + r.status);
    }
    throw new Error("wav conversion timed out");
  }

  // MIDI: GET /api/gen/{id}/midi/ returns {"state":"running"} then
  // {"state":"complete","instruments":[{name,is_drum,notes:[{pitch,start,end,velocity}]}]}
  async function getMidiData(id) {
    if (!operationOptions?.creditApproved) throw new Error("MIDI conversion was not approved");
    for (let n = 0; n < 60; n++) {
      const r = await api("GET", `/api/gen/${id}/midi/`);
      if (r.status !== 200) throw new Error("midi " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      if (r.j?.state === "complete") {
        if (!Array.isArray(r.j.instruments)) throw new Error("midi response missing instruments");
        return r.j;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(r.j?.state))
        throw new Error("midi conversion " + r.j.state + (r.j.error ? ": " + r.j.error : ""));
      if (r.j?.state !== "running" && r.j?.state !== "pending" && r.j?.state !== "queued")
        throw new Error("midi returned unexpected state: " + String(r.j?.state));
      await stopSleep(5000);
      if (stopRequested) throw new Error("midi conversion stopped");
    }
    throw new Error("midi conversion timed out");
  }

  // build a standard SMF (type 0) MIDI file from Suno's instrument/note data
  function midiToBlob(data) {
    const PPQ = 480; // ticks per quarter note
    const ticksPerSec = (PPQ * 120) / 60; // assume 120 BPM
    const events = [];
    const ins = data.instruments || [];
    let melodicChannel = 0;
    for (const instrument of ins) {
      const notes = instrument.notes || [];
      let channel;
      if (instrument.is_drum) channel = 9; // General MIDI percussion channel 10
      else {
        channel = melodicChannel++ % 15;
        if (channel >= 9) channel++;
      }
      for (const n of notes) {
        const vel = Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.7) * 127)));
        const pitch = Math.max(0, Math.min(127, Math.round(Number.isFinite(n.pitch) ? n.pitch : 60)));
        const onT = Math.max(0, Math.round((n.start ?? 0) * ticksPerSec));
        const offT = Math.max(onT + 1, Math.round((n.end ?? n.start ?? 0) * ticksPerSec));
        events.push([onT, [0x90 | channel, pitch, vel]]);
        events.push([offT, [0x80 | channel, pitch, 0]]);
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

  const collisionSafeId = (entry, peers) => {
    const short = entry.id.slice(0, 8);
    return peers.some((candidate) => candidate.id !== entry.id && candidate.id.slice(0, 8) === short)
      ? entry.id : short;
  };
  const withSuffix = (base, suffix) => {
    const suffixChars = Array.from(suffix);
    const room = Math.max(1, 220 - suffixChars.length);
    const head = Array.from(base).slice(0, room).join("").replace(/[. ]+$/g, "") || "untitled";
    return head + suffix;
  };
  const collisionKey = (name) => sanitize(name).normalize("NFC").toLowerCase();

  // Preserve the established "<title> [<id8>]" layout unless two clips really
  // share that output path, in which case the full IDs prevent an overwrite.
  const folderFor = (entry) => {
    const base = sanitize(entry.title);
    const key = collisionKey(entry.title);
    const peers = [...scanState.songs.values()].filter((candidate) =>
      !candidate.isStem && !candidate.isInfill && collisionKey(candidate.title) === key
    );
    return withSuffix(base, " [" + collisionSafeId(entry, peers) + "]");
  };

  // Suno may generate the same named stem more than once for one parent. Keep
  // the friendly name when unique, and disambiguate every member of a duplicate
  // set so reruns map each clip to the same file instead of silently skipping it.
  const stemFileBase = (entry) => {
    const base = sanitize(entry.stemName || entry.title);
    const key = collisionKey(entry.stemName || entry.title);
    const duplicates = [...scanState.songs.values()].filter((candidate) =>
      candidate.isStem &&
      candidate.parentId === entry.parentId &&
      collisionKey(candidate.stemName || candidate.title) === key
    );
    return duplicates.length > 1
      ? withSuffix(base, " [" + collisionSafeId(entry, duplicates) + "]") : base;
  };

  const variationFileBase = (entry) => {
    const base = sanitize(entry.title);
    const key = collisionKey(entry.title);
    const duplicates = [...scanState.songs.values()].filter((candidate) =>
      candidate.isInfill &&
      candidate.parentId === entry.parentId &&
      collisionKey(candidate.title) === key
    );
    return duplicates.length > 1
      ? withSuffix(base, " [" + collisionSafeId(entry, duplicates) + "]") : base;
  };

  const orphanParentFolder = (entry) => {
    const base = sanitize(entry.title);
    const key = collisionKey(entry.title);
    const collisions = [...scanState.songs.values()].filter((candidate) =>
      candidate.isStem === entry.isStem &&
      candidate.isInfill === entry.isInfill &&
      !scanState.songs.has(candidate.parentId) &&
      collisionKey(candidate.title) === key &&
      candidate.parentId !== entry.parentId
    );
    // A parent may be absent from the selected feeds. Different absent parents
    // must not collapse into the same legacy title-only fallback directory.
    return collisions.length ? withSuffix(base, " [" + sanitize(entry.parentId || entry.id) + "]") : base;
  };

  // download() returns { files: "mp3+wav:fail+midi:skip", fails: 1 }
  async function download(entry, dir) {
    const { id, title, isStem, parentId } = entry;
    const clean = sanitize(title);
    const fmt = operationOptions?.formats || getFormats();
    const out = { files: [], fails: 0 };
    const saveFallbackMp3 = async (name) => {
      try {
        const blob = await fetchBlob(`https://cdn1.suno.ai/${id}.mp3`);
        saveViaDownload(name + ".mp3", blob);
        out.files.push("mp3");
      } catch (e) { out.fails++; out.files.push("mp3:fail"); }
    };
    const saveMp3 = async (d, name) => {
      if (await existsInFolder(d, name + ".mp3")) out.files.push("mp3:skip");
      else {
        try {
          const blob = await fetchBlob(`https://cdn1.suno.ai/${id}.mp3`);
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
          const blob = await fetchBlob(url);
          await saveToFolder(d, name + ".wav", blob);
          out.files.push("wav");
        } catch (e) { out.fails++; out.files.push("wav:fail"); }
      }
    };
    const saveMidi = async (d, name) => {
      if (d && await existsInFolder(d, name + ".mid")) out.files.push("midi:skip");
      else {
        try {
          const data = await getMidiData(id);
          const blob = midiToBlob(data);
          if (d) await saveToFolder(d, name + ".mid", blob);
          else saveViaDownload(name + ".mid", blob);
          out.files.push("midi");
        } catch (e) { out.fails++; out.files.push("midi:fail"); }
      }
    };
    if (isStem) {
      const parentEntry = scanState.songs.get(parentId);
      const fname = stemFileBase(entry);
      if (fmt.mp3) {
        if (dir) {
          const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : orphanParentFolder(entry));
          const stemsDir = await getOrCreateSubDir(parentFolder, "stems");
          await saveMp3(stemsDir, fname);
        } else {
          const parent = sanitize(parentEntry?.title || "stem");
          await saveFallbackMp3(withSuffix(parent + " - " + fname, " [" +
            collisionSafeId(entry, [...scanState.songs.values()]) + "]"));
        }
      }
      return out;
    }
    if (entry.isInfill) {
      // section-edit clips (e.g. "[01:55.0 - 02:18.4] {verse]") go under the
      // parent song's folder in a variations/ subfolder
      const parentEntry = scanState.songs.get(parentId);
      if (fmt.mp3) {
        if (dir) {
          const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : orphanParentFolder(entry));
          const varsDir = await getOrCreateSubDir(parentFolder, "variations");
          await saveMp3(varsDir, variationFileBase(entry));
        } else {
          const parent = sanitize(parentEntry?.title || "variation");
          await saveFallbackMp3(withSuffix(parent + " - " + variationFileBase(entry), " [" +
            collisionSafeId(entry, [...scanState.songs.values()]) + "]"));
        }
      }
      return out;
    }
    const songDir = await getOrCreateSubDir(dir, folderFor(entry));
    const sameTitleSongs = [...scanState.songs.values()].filter((candidate) =>
      !candidate.isStem && !candidate.isInfill && collisionKey(candidate.title) === collisionKey(title)
    );
    const fallbackBase = sameTitleSongs.length > 1
      ? withSuffix(clean, " [" + collisionSafeId(entry, sameTitleSongs) + "]") : clean;
    if (fmt.mp3) {
      if (dir && await existsInFolder(songDir, clean + ".mp3")) out.files.push("mp3:skip");
      else if (!dir) {
        try {
          const blob = await fetchBlob(`https://cdn1.suno.ai/${id}.mp3`);
          saveViaDownload(fallbackBase + ".mp3", blob);
          out.files.push("mp3");
        } catch (e) { out.fails++; out.files.push("mp3:fail"); }
      } else await saveMp3(songDir, clean);
    }
    if (fmt.wav) {
      if (dir && await existsInFolder(songDir, clean + ".wav")) out.files.push("wav:skip");
      else if (!dir) {
        try {
          const url = await getWavUrl(id);
          const blob = await fetchBlob(url);
          saveViaDownload(fallbackBase + ".wav", blob);
          out.files.push("wav");
        } catch (e) { out.fails++; out.files.push("wav:fail"); }
      } else await saveWav(songDir, clean);
    }
    if (fmt.midi) await saveMidi(songDir, dir ? clean : fallbackBase);
    return out;
  }

  // ---------- cache (suno-cache.json lives in the chosen folder) ----------
  const CACHE_NAME = "suno-cache.json";
  let persistChain = Promise.resolve();
  async function readCache(dir) {
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(CACHE_NAME);
      const text = await (await handle.getFile()).text();
      const cached = JSON.parse(text);
      if (!cached || typeof cached !== "object" || Array.isArray(cached))
        throw new Error("cache root is not an object");
      if (cached.songs !== undefined && !Array.isArray(cached.songs))
        throw new Error("cache songs field is not an array");
      if (cached.seenIds !== undefined && !Array.isArray(cached.seenIds))
        throw new Error("cache seenIds field is not an array");
      if ((cached.songs || []).some((song) => !song || typeof song !== "object" || typeof song.id !== "string"))
        throw new Error("cache contains an invalid song entry");
      if ((cached.seenIds || []).some((id) => typeof id !== "string"))
        throw new Error("cache contains an invalid seen ID");
      return cached;
    } catch (err) {
      // Missing caches are normal, including for caches written by older runs.
      // Parse, permission, and I/O failures must be visible so a valid resume
      // cache is never silently replaced by a new partial scan.
      if (err?.name === "NotFoundError") return null;
      throw new Error("could not read " + CACHE_NAME + ": " + (err?.message || err));
    }
  }
  async function persistCache(dir) {
    if (!dir) return true;
    if (destroyed) return false;
    const data = JSON.stringify({
      savedAt: Date.now(),
      libCursor: scanState.libCursor,
      wsCursor: scanState.wsCursor,
      libDone: scanState.libDone,
      wsDone: scanState.wsDone,
      stemsIncluded: scanState.stemsIncluded,
      songs: [...scanState.songs.values()],
      seenIds: [...scanState.seenIds],
      scanned: scanState.scanned,
    }, null, 2);
    // Recover the queue after an earlier rejected write, but let this write's
    // error reach its caller so the UI never claims unsaved progress is safe.
    persistChain = persistChain.catch(() => {}).then(async () => {
      if (destroyed) return;
      let w = null;
      try {
        const handle = await dir.getFileHandle(CACHE_NAME, { create: true });
        w = await handle.createWritable();
        await w.write(data);
        await w.close();
      } catch (err) {
        if (w) try { await w.abort(); } catch {}
        throw new Error("could not save " + CACHE_NAME + ": " + (err?.message || err));
      }
    });
    await persistChain;
    return true;
  }

  function restoreScanState(cached) {
    if (!cached) return;
    scanState.songs = new Map((cached.songs || []).map((s) => [s.id, s]));
    scanState.seenIds = new Set(cached.seenIds || []);
    scanState.libCursor = cached.libCursor ?? null;
    scanState.wsCursor = cached.wsCursor ?? null;
    scanState.libDone = !!cached.libDone;
    scanState.wsDone = !!cached.wsDone;
    // Old caches did not record this explicitly. Existing stem entries prove
    // that stems were included; zero-stem old caches get one compatibility scan.
    scanState.stemsIncluded = typeof cached.stemsIncluded === "boolean"
      ? cached.stemsIncluded
      : (cached.songs || []).some((s) => s.isStem);
    scanState.scanned = cached.scanned || 0;
  }

  function resetScanState() {
    scanState.songs = new Map();
    scanState.seenIds = new Set();
    scanState.libCursor = null;
    scanState.wsCursor = null;
    scanState.libDone = false;
    scanState.wsDone = false;
    scanState.stemsIncluded = false;
    scanState.scanned = 0;
  }

  async function enumerateSongs(dir) {
    setStatus("Enumerating songs...");
    scanState.stemsIncluded = scanState.stemsIncluded || includeStems();
    const onProgress = (msg) => setStatus(msg);
    const scans = await Promise.allSettled([
      getLibrary(dir, onProgress, persistCache),
      getWorkspace(dir, onProgress, persistCache),
    ]);
    const failedScan = scans.find((result) => result.status === "rejected");
    if (failedScan) throw failedScan.reason;
    await persistCache(dir);
    let out = [...scanState.songs.values()];
    if (!includeStems()) out = out.filter((s) => !s.isStem);
    if (LIMIT > 0) out.splice(LIMIT);
    return { songs: out };
  }

  // ---------- flow ----------
  const usePicker = typeof window.showDirectoryPicker === "function";
  let songs = [];
  let rescan = false;
  let pickedDir = null;
  let songsDir = null;
  let songsIncludedStems = null;

  async function ensureSongs(dir) {
    const wantsStems = includeStems();
    if (songs.length && !rescan && songsDir === dir && songsIncludedStems === wantsStems) return true;
    const cached = await readCache(dir);
    const cacheIncludedStems = cached && (typeof cached.stemsIncluded === "boolean"
      ? cached.stemsIncluded
      : (cached.songs || []).some((s) => s.isStem));
    const needStemRescan = cached && includeStems() && !cacheIncludedStems;
    if (cached && !rescan && !needStemRescan && cached.libDone && cached.wsDone) {
      restoreScanState(cached);
      songs = [...scanState.songs.values()];
      if (!includeStems()) songs = songs.filter((s) => !s.isStem);
      if (LIMIT > 0) songs = songs.slice(0, LIMIT);
      songsDir = dir;
      songsIncludedStems = wantsStems;
      setStatus(`Using cache: ${songs.length} songs.\nPress Start to download.`);
      return true;
    }
    stopRequested = false;
    earlyStop = false; // stems newly requested -> must walk the full feed once
    if (cached) restoreScanState(cached);
    else resetScanState();
    if (needStemRescan) {
      // force a full re-walk so stems get collected (done flags from cache would skip it)
      scanState.songs = new Map();
      scanState.seenIds = new Set();
      scanState.libCursor = null;
      scanState.wsCursor = null;
      scanState.libDone = false;
      scanState.wsDone = false;
      scanState.stemsIncluded = true;
    }
    const { songs: fresh } = await enumerateSongs(dir);
    if (stopRequested) { setStatus("Scan stopped. Progress saved - rerun to resume."); return false; }
    songs = fresh;
    songsDir = dir;
    songsIncludedStems = wantsStems;
    if (!songs.length) { setStatus("No songs found."); return false; }
    setStatus(`Found ${songs.length} songs (including stems).\nPress Start to download.`);
    return true;
  }

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.style.cssText = "width:100%;padding:6px;margin-top:8px;border:0;border-radius:6px;background:#555;color:#fff;font-weight:600;cursor:pointer";
  stopBtn.disabled = true;
  stopBtn.addEventListener("click", () => {
    stopRequested = true;
    operationController?.abort();
  });
  panel.appendChild(stopBtn);

  const startBtn = btn;
  let busy = false;
  let rescanLink = null;
  const setBusy = (isBusy) => {
    // Set the guard before any awaited picker/API call so rapid clicks cannot
    // start overlapping scans or downloads.
    busy = isBusy;
    startBtn.disabled = isBusy;
    stopBtn.disabled = !isBusy;
    pickBtn.disabled = isBusy;
    for (const cb of [mp3Check, wavCheck, midiCheck, stemsCheck]) cb.disabled = isBusy;
    if (rescanLink) {
      rescanLink.setAttribute("aria-disabled", String(isBusy));
      rescanLink.style.pointerEvents = isBusy ? "none" : "auto";
      rescanLink.style.opacity = isBusy ? "0.5" : "1";
    }
  };

  // choose folder only (does not start)
  pickBtn.addEventListener("click", async () => {
    if (!usePicker || busy) return;
    setBusy(true);
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      if (destroyed) return;
      if (dir !== pickedDir) {
        songs = [];
        songsDir = null;
        songsIncludedStems = null;
      }
      pickedDir = dir;
      setStatus("Folder selected. Press Start to download.");
    } catch (e) {
      setStatus("Folder picker cancelled.");
    } finally {
      setBusy(false);
    }
  });

  // start downloads (scans first if no cache)
  startBtn.addEventListener("click", async () => {
    if (busy) return;
    operationOptions = {
      formats: getFormats(),
      includeStems: stemsCheck.checked || INCLUDE_STEMS,
      creditApproved: false,
    };
    if (!operationOptions.formats.mp3 && !operationOptions.formats.wav && !operationOptions.formats.midi) {
      operationOptions = null;
      setStatus("Select at least one format before starting.");
      return;
    }
    operationController = new AbortController();
    setBusy(true);
    try {
      let dir = pickedDir;
      if (!dir && usePicker) {
        try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); }
        catch (e) { setStatus("Folder picker cancelled."); return; }
        if (destroyed) return;
        pickedDir = dir;
      }
      if (stopRequested) { setStatus("Stopped before scanning."); return; }
      if (!(await ensureSongs(dir))) return;
      const fmtNow = operationOptions.formats;
      if (fmtNow.wav || fmtNow.midi) {
        const parts = [];
        if (fmtNow.wav) parts.push("WAV conversion");
        if (fmtNow.midi) parts.push("MIDI conversion");
        if (!confirm(
          parts.join(" and ") +
          " use your Suno credits and can drain your balance on a large library.\n\n" +
          "MP3 downloads and already-generated stem downloads are free.\n\nContinue?"
        )) { setStatus("Cancelled."); return; }
        operationOptions.creditApproved = true;
      }
      let ok = 0, failed = 0, skipped = 0;
      for (let i = 0; i < songs.length; i++) {
        if (stopRequested) break;
        const e = songs[i];
        setStatus(`[${i + 1}/${songs.length}] ${e.title}`);
        try {
          const r = await download(e, dir);
          const files = r.files.join("+");
          const wasSkipped = r.files.some((f) => f.endsWith(":skip")) && r.files.every((f) => f.endsWith(":skip"));
          if (!r.files.length) skipped++;
          else if (wasSkipped) skipped++;
          else if (r.fails > 0) failed++;
          else ok++;
          setStatus(`[${i + 1}/${songs.length}] ${files}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
        } catch (err) {
          failed++;
          setStatus(`[${i + 1}/${songs.length}] FAILED: ${err.message}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
        }
        if (i < songs.length - 1) await stopSleep(PAUSE_MS);
      }
      setStatus(stopRequested
        ? `Stopped. ${ok} downloaded, ${skipped} skipped, ${failed} failed. Rerun to resume.`
        : `Done. ${ok} downloaded, ${skipped} skipped, ${failed} failed.`);
      startBtn.textContent = stopRequested ? "Resume" : "Done";
    } catch (err) {
      setStatus("Error: " + (err && err.message ? err.message : err));
      startBtn.textContent = "Start";
    } finally {
      operationController?.abort();
      operationController = null;
      stopRequested = false;
      operationOptions = null;
      setBusy(false);
    }
  });

  // small re-scan link so new songs get picked up without deleting the cache
  if (usePicker) {
    const link = document.createElement("a");
    rescanLink = link;
    link.textContent = "Re-scan for new songs";
    link.style.cssText = "display:block;margin-top:8px;color:#ff6b9d;cursor:pointer;font-size:12px;text-decoration:underline";
    link.addEventListener("click", async () => {
      if (busy) return;
      operationOptions = {
        formats: getFormats(),
        includeStems: stemsCheck.checked || INCLUDE_STEMS,
      };
      operationController = new AbortController();
      setBusy(true);
      rescan = true;
      songs = [];
      songsDir = null;
      songsIncludedStems = null;
      stopRequested = false;
      setStatus("Re-scanning...");
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        if (destroyed) return;
        if (stopRequested) { setStatus("Re-scan stopped before scanning."); return; }
        pickedDir = dir;
        const cached = await readCache(dir);
        resetScanState();
        scanState.stemsIncluded = !!(cached && (typeof cached.stemsIncluded === "boolean"
          ? cached.stemsIncluded
          : (cached.songs || []).some((s) => s.isStem)));
        // If this cache predates a stem-inclusive scan, walk every page once;
        // seenIds also contains excluded stems and is not a safe early boundary.
        earlyStop = scanState.stemsIncluded || !includeStems();
        knownBeforeRescan = new Set(cached?.seenIds || []);
        if (cached && cached.songs) {
          // seed from cache so the early-stop boundary knows what's already seen,
          // but keep done flags false so feeds actually re-walk
          for (const s of cached.songs) scanState.songs.set(s.id, s);
          for (const id of cached.seenIds || []) scanState.seenIds.add(id);
        }
        const { songs: fresh } = await enumerateSongs(dir);
        if (stopRequested) {
          rescan = false;
          earlyStop = false;
          setStatus("Re-scan stopped. Progress saved - rerun to resume.");
          return;
        }
        songs = fresh;
        songsDir = dir;
        songsIncludedStems = includeStems();
        rescan = false;
        earlyStop = false;
        knownBeforeRescan = new Set();
        setStatus(`Re-scan complete: ${songs.length} songs.\nClick "Start" to download.`);
      } catch (e) {
        rescan = false;
        earlyStop = false;
        setStatus("Re-scan failed or cancelled: " + e.message);
      } finally {
        operationController?.abort();
        operationController = null;
        operationOptions = null;
        knownBeforeRescan = new Set();
        stopRequested = false;
        setBusy(false);
      }
    });
    panel.appendChild(link);
  }

  for (const cb of [mp3Check, wavCheck, midiCheck, stemsCheck]) {
    cb.addEventListener("change", refreshCredits);
  }
  refreshCredits().catch((err) => {
    if (!destroyed) creditsBox.textContent = "Could not read credit balance: " + (err?.message || err);
  });
})();
