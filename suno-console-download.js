/**
 * Suno bulk downloader (paste into browser console while logged into suno.com).
 *
 * Downloads all songs from your Library + Workspace as MP3, WAV, and/or MIDI into a
 * folder of your choice - no per-file save prompts. Each song gets its own
 * sub-folder:
 *
 *   <your folder>/
 *     <title> [id8]/           one unique folder per song (id disambiguates dupes)
 *       <title>.mp3            MP3 download
 *       <title>.wav            WAV download
 *       <title>.mid            MIDI download
 *       stems/                 (when stems enabled) Vocals.mp3, Drums.mp3, ...
 *       variations/            section-edit clips
 *     suno-cache.json          scan cache (auto-created)
 *
 * Usage:
 *   1. Open https://suno.com and make sure you're logged in.
 *   2. Open DevTools (F12) and switch to the Console tab.
 *   3. Adjust FORMAT / LIMIT / INCLUDE below if you want.
 *   4. Paste this whole script and press Enter.
 *   5. In the panel, choose formats/folder and click "Start".
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
  // Publish a pending replacement before yielding. If the script is pasted
  // several times while an old write is settling, each paste cancels and waits
  // for its predecessor, so only the newest invocation can initialize.
  if (previousInstance && typeof previousInstance.destroy === "function") {
    let replacementCancelled = false;
    const predecessorDone = Promise.resolve(previousInstance.destroy());
    const pendingInstance = {
      async destroy() {
        replacementCancelled = true;
        await predecessorDone;
      },
    };
    window[INSTANCE_KEY] = pendingInstance;
    await predecessorDone;
    if (replacementCancelled || window[INSTANCE_KEY] !== pendingInstance) return;
  }
  document.getElementById("suno-bulk-downloader-panel")?.remove();

  const FORMAT = "mp3"; // default checkbox preset: 'mp3', 'wav', or 'both' (MIDI is selected in the panel)
  const LIMIT = 0; // 0 = all download items, or N = first N song/stem/variation entries
  const INCLUDE_LIBRARY = true; // your Suno library (created + liked songs)
  const INCLUDE_WORKSPACE = true; // your workspace (drafts/in-progress)
  const INCLUDE_STEMS = false; // also download already-generated stems (no credits needed)
  const PAUSE_MS = 1500; // delay between songs (be polite to the API)
  const MAX_SCAN_PAGES = 10000; // final backstop for a broken endlessly-paginated API

  const API = "https://studio-api-prod.suno.com";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const portableSize = (value) => {
    let bytes = 0;
    let codeUnits = 0;
    for (const char of String(value)) {
      const cp = char.codePointAt(0);
      bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      codeUnits += char.length;
    }
    return { bytes, codeUnits };
  };
  const truncatePortable = (value, maxBytes, maxCodeUnits = maxBytes) => {
    let result = "";
    let bytes = 0;
    let codeUnits = 0;
    for (const char of String(value)) {
      const cp = char.codePointAt(0);
      const charBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (bytes + charBytes > maxBytes || codeUnits + char.length > maxCodeUnits) break;
      result += char;
      bytes += charBytes;
      codeUnits += char.length;
    }
    return result;
  };
  const sanitize = (name) => {
    let clean = String(name ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    if (!clean) clean = "untitled";
    // Windows rejects these basenames even with an extension. Keep ordinary
    // legacy names unchanged, but make unsafe names portable across platforms.
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(clean)) clean = "_" + clean;
    // Native component limits are measured in UTF-8 bytes on common Unix/macOS
    // filesystems and UTF-16 code units on Windows. A code-point-only cap lets
    // emoji/CJK titles exceed both limits even though an ASCII title is safe.
    clean = truncatePortable(clean, 180).replace(/[. ]+$/g, "");
    return clean || "untitled";
  };

  // ---------- small floating panel ----------
  let stopRequested = false;
  let destroyed = false;
  const instanceController = new AbortController();
  let operationController = null;
  const operationCancelled = () => destroyed || stopRequested ||
    !!operationController?.signal.aborted || instanceController.signal.aborted;
  // Directory creation and file writes cannot take an AbortSignal. Keep every
  // in-flight filesystem mutation here so a replacement instance waits for the
  // old one to become completely quiescent before it starts using the folder.
  const activeFileWrites = new Set();
  // Includes picker waits and read-only probes as well as scans/downloads. A
  // replacement instance waits for these handlers to settle, so an old pasted
  // copy cannot remain alive behind the new panel.
  const activeTasks = new Set();
  const trackTask = (task) => {
    activeTasks.add(task);
    task.then(() => activeTasks.delete(task), () => activeTasks.delete(task));
    return task;
  };
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
      <input type="checkbox" id="suno-dl-wav"> WAV (conversion uses credits)
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
      await Promise.allSettled([...activeTasks]);
      // File System Access mutations cannot take an AbortSignal. Waiting for
      // the small set already in flight prevents a replacement instance from
      // creating directories or writing the same file concurrently.
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
    const apiCredits = await api("GET", "/api/billing/credits", null, 1, { reportStatus: false });
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
    const { retryAmbiguous = true, reportStatus = true } = options;
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
        const authStopped = new Promise((_, reject) => {
          const rejectOnAbort = () => {
            const error = new Error("authentication request aborted");
            error.name = "AbortError";
            reject(error);
          };
          requestController.signal.addEventListener("abort", rejectOnAbort, { once: true });
          if (requestController.signal.aborted) rejectOnAbort();
        });
        const requestHeaders = await Promise.race([headers(refreshToken), authStopped]);
        res = await Promise.race([fetch(API + p, {
          method,
          headers: requestHeaders,
          body: body ? JSON.stringify(body) : undefined,
          signal: requestController.signal,
        }), authStopped]);
      } catch (err) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        if (!retryAmbiguous || i >= retries) {
          return { status: 0, j: { raw: (timedOut ? "request timed out" : "network request failed") + " after retries: " + (err?.message || err) } };
        }
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        if (reportStatus) setStatus("Network error - retrying in " + (wait / 1000) + "s...");
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
        if (reportStatus) setStatus("Rate limited - waiting " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        continue;
      }
      if (res.status >= 500 && res.status <= 599 && retryAmbiguous && i < retries) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        if (reportStatus) setStatus("Server error " + res.status + " - retrying in " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        continue;
      }
      let text;
      try {
        // Some response implementations do not reject body reads when their
        // AbortSignal fires. Race the read explicitly so timeout, Stop, and a
        // replacement paste always release the operation.
        const bodyAborted = new Promise((_, reject) => {
          const rejectOnAbort = () => {
            const error = new Error("response body aborted");
            error.name = "AbortError";
            reject(error);
          };
          requestController.signal.addEventListener("abort", rejectOnAbort, { once: true });
          if (requestController.signal.aborted) rejectOnAbort();
        });
        text = await Promise.race([res.text(), bodyAborted]);
      } catch (err) {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
        if (destroyed || stopRequested || signal.aborted)
          return { status: 0, j: { raw: "request stopped" } };
        if (!retryAmbiguous || i >= retries)
          return { status: 0, j: { raw: (timedOut ? "response timed out" : "response body failed") + " after retries: " + (err?.message || err) } };
        const wait = Math.min(1000 * Math.pow(2, i), 30000);
        if (reportStatus) setStatus("Network error - retrying in " + (wait / 1000) + "s...");
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

  const clipAudioUrl = (c) => {
    const media = c.media_urls;
    const candidates = [
      c.audio_url,
      media?.audio_url,
      media?.audio,
      media?.mp3,
      ...(Array.isArray(media) ? media.map((item) => item?.audio_url || item?.url) : []),
    ];
    for (const value of candidates) {
      if (typeof value !== "string" || !value.trim()) continue;
      try {
        const parsed = new URL(value);
        if (parsed.protocol === "https:") return parsed.href;
      } catch {}
    }
    return null;
  };

  const toEntry = (c) => {
    const e = { id: c.id, title: String(c.title || "untitled").trim() };
    const audioUrl = clipAudioUrl(c);
    if (audioUrl) e.audioUrl = audioUrl;
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
    libDone: !INCLUDE_LIBRARY,
    wsDone: !INCLUDE_WORKSPACE,
    stemsIncluded: false,
    scanned: 0,
  };

  // during a re-scan we can stop a feed as soon as a page is 100% already-seen
  // (feeds are newest-first, so anything behind a fully-known page is known too)
  let earlyStopLibrary = false;
  let earlyStopWorkspace = false;
  // This must remain an immutable snapshot. The library and workspace scans run
  // concurrently, so using their live shared seenIds would let one scan make new
  // clips look old to the other and could stop a feed too early.
  let knownBeforeRescan = new Set();

  const progress = (kind, page) =>
    setStatus(kind + " page " + page +
      " | scanned " + scanState.scanned + " clips, found " + scanState.songs.size + " songs" +
      (scanState.songs.size ? "" : " (mostly stems - will skip them)"));

  const cursorKey = (cursor) => {
    try { return JSON.stringify(cursor); } catch { return String(cursor); }
  };
  const validClipId = (value) => typeof value === "string" && value.trim().length > 0;
  const validCursor = (value) => value === null ||
    (typeof value === "string" && value.length > 0) ||
    (value && typeof value === "object" && !Array.isArray(value));

  const responseCursor = (body, feedName) => {
    if (!Object.prototype.hasOwnProperty.call(body || {}, "next_cursor"))
      throw new Error(feedName + " feed error: response is missing next_cursor");
    const next = body.next_cursor;
    if (!validCursor(next)) throw new Error(feedName + " feed error: invalid next_cursor");
    if (body.has_more !== undefined) {
      if (typeof body.has_more !== "boolean")
        throw new Error(feedName + " feed error: has_more is not a boolean");
      if (body.has_more !== (next !== null))
        throw new Error(feedName + " feed error: has_more contradicts next_cursor");
    }
    return next;
  };

  const queryCursor = (cursor) => typeof cursor === "string" ? cursor : JSON.stringify(cursor);
  const cacheMatchesFeedSelection = (cached) => {
    if (!cached) return true;
    const hasSelection = cached.includeLibrary !== undefined || cached.includeWorkspace !== undefined;
    // Legacy caches were created with both feeds enabled by default. Preserve
    // their fast resume path for that default, but non-default configurations
    // must re-scan because old entries have no feed provenance.
    if (!hasSelection) return INCLUDE_LIBRARY && INCLUDE_WORKSPACE;
    return cached.includeLibrary === INCLUDE_LIBRARY && cached.includeWorkspace === INCLUDE_WORKSPACE;
  };

  async function getLibrary(dir, onProgress, persist) {
    if (!INCLUDE_LIBRARY || scanState.libDone) return;
    let cursor = scanState.libCursor;
    let page = 0;
    const requestedCursors = new Set();
    do {
      if (stopRequested) break;
      page++;
      if (page > MAX_SCAN_PAGES) throw new Error("library feed exceeded the pagination safety limit");
      requestedCursors.add(cursorKey(cursor));
      progress("Scanning library", page);
      const r = await api("POST", "/api/feed/v3", { cursor, limit: 50, filters: {} });
      if (r.status !== 200 && (stopRequested || destroyed)) return;
      if (r.status !== 200)
        throw new Error("library feed error " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      if (!Array.isArray(r.j?.clips))
        throw new Error("library feed error: unexpected response shape");
      const nextCursor = responseCursor(r.j, "library");
      const clips = r.j.clips;
      scanState.scanned += clips.length;
      let known = 0;
      for (const c of clips) {
        if (!c || typeof c !== "object" || !validClipId(c.id))
          throw new Error("library feed error: invalid clip entry");
        if (earlyStopLibrary && knownBeforeRescan.has(c.id)) known++;
        scanState.seenIds.add(c.id);
        if (c.status === "complete" && (includeStems() || !isStem(c))) {
          const entry = toEntry(c);
          const previous = scanState.songs.get(c.id);
          if (entry.isStem && previous?.stemOutputBase)
            entry.stemOutputBase = previous.stemOutputBase;
          if (entry.isInfill && previous?.variationOutputBase)
            entry.variationOutputBase = previous.variationOutputBase;
          scanState.songs.set(c.id, entry);
        }
      }
      cursor = nextCursor;
      if (cursor && requestedCursors.has(cursorKey(cursor)))
        throw new Error("library feed pagination cursor did not advance");
      scanState.libCursor = cursor;
      if (!cursor) scanState.libDone = true;
      await persist(dir);
      if (earlyStopLibrary && clips.length && known === clips.length) {
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
    const requestedCursors = new Set();
    do {
      if (stopRequested) break;
      page++;
      if (page > MAX_SCAN_PAGES) throw new Error("project feed exceeded the pagination safety limit");
      requestedCursors.add(cursorKey(cursor));
      progress("Scanning workspace", page);
      const qs = "?scope=default&limit=50" +
        (cursor ? `&cursor=${encodeURIComponent(queryCursor(cursor))}` : "");
      const r = await api("GET", "/api/project/feed" + qs);
      if (r.status !== 200 && (stopRequested || destroyed)) return;
      if (r.status !== 200)
        throw new Error("project feed error " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      if (!Array.isArray(r.j?.items))
        throw new Error("project feed error: unexpected response shape");
      const nextCursor = responseCursor(r.j, "project");
      const items = r.j.items;
      let scannedThisPage = 0;
      let known = 0;
      for (const it of items) {
        if (!it || typeof it !== "object" || typeof it.type !== "string")
          throw new Error("project feed error: invalid item entry");
        const c = it.clip;
        if (it.type !== "clip" || !c) continue;
        if (typeof c !== "object" || !validClipId(c.id))
          throw new Error("project feed error: invalid clip entry");
        scannedThisPage++;
        if (earlyStopWorkspace && knownBeforeRescan.has(c.id)) known++;
        scanState.seenIds.add(c.id);
        if (c.status === "complete" && (includeStems() || !isStem(c))) {
          const entry = toEntry(c);
          const previous = scanState.songs.get(c.id);
          if (entry.isStem && previous?.stemOutputBase)
            entry.stemOutputBase = previous.stemOutputBase;
          if (entry.isInfill && previous?.variationOutputBase)
            entry.variationOutputBase = previous.variationOutputBase;
          scanState.songs.set(c.id, entry);
        }
      }
      scanState.scanned += scannedThisPage;
      cursor = nextCursor;
      if (cursor && requestedCursors.has(cursorKey(cursor)))
        throw new Error("project feed pagination cursor did not advance");
      scanState.wsCursor = cursor;
      if (!cursor) scanState.wsDone = true;
      await persist(dir);
      if (earlyStopWorkspace && scannedThisPage && known === scannedThisPage) {
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
    const creation = (async () => {
      if (operationCancelled()) throw new Error("download stopped");
      try {
        const child = await parent.getDirectoryHandle(name, { create: true });
        if (operationCancelled()) throw new Error("download stopped");
        return child;
      } catch (e) {
        if (operationCancelled()) throw new Error("download stopped");
        throw new Error("could not create sub-folder '" + name + "': " + e.message);
      }
    })();
    activeFileWrites.add(creation);
    try { return await creation; } finally { activeFileWrites.delete(creation); }
  }
  async function saveToFolder(dir, name, blob) {
    const write = (async () => {
      let w = null;
      try {
        if (operationCancelled()) throw new Error("download stopped");
        const handle = await dir.getFileHandle(name, { create: true });
        if (operationCancelled()) throw new Error("download stopped");
        w = await handle.createWritable();
        if (operationCancelled()) throw new Error("download stopped");
        await w.write(blob);
        if (operationCancelled()) throw new Error("download stopped");
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
    } catch (err) {
      // Only an absent file is safe to treat as downloadable. Permission and
      // I/O errors may refer to an existing file; continuing with create:true
      // could truncate it when createWritable() is opened.
      if (err?.name === "NotFoundError") return false;
      throw new Error("could not check existing file '" + name + "': " + (err?.message || err));
    }
  }

  function saveViaDownload(name, blob) {
    if (destroyed || stopRequested || operationController?.signal.aborted || instanceController.signal.aborted)
      throw new Error("download stopped");
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  const validateMediaBlob = async (blob, contentType, kind, url) => {
    const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    if (mime.startsWith("text/") || mime.startsWith("image/") || mime.startsWith("video/") ||
        mime === "application/json" || mime.endsWith("+json") ||
        mime === "application/xml" || mime.endsWith("+xml"))
      throw new Error("unexpected " + (mime || "non-audio") + " response while fetching " + url);

    // CDNs sometimes serve media as application/octet-stream or omit the MIME
    // type, so validate the container bytes rather than requiring one exact
    // header. This also catches a binary error/image body returned with HTTP 200.
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
    if (kind === "wav") {
      let container = head.length >= 12 &&
        head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // RIFF
        head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45; // WAVE
      let hasFormat = false;
      let hasAudioData = false;
      if (container) {
        const declaredRiffSize = new DataView(head.buffer, head.byteOffset + 4, 4).getUint32(0, true);
        const containerEnd = declaredRiffSize + 8;
        if (declaredRiffSize < 4 || containerEnd > blob.size) container = false;
        for (let offset = 12, chunks = 0; container && chunks < 256 && offset + 8 <= containerEnd; chunks++) {
          const chunkHead = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
          const chunkId = String.fromCharCode(chunkHead[0], chunkHead[1], chunkHead[2], chunkHead[3]);
          const size = new DataView(chunkHead.buffer, chunkHead.byteOffset + 4, 4).getUint32(0, true);
          const dataStart = offset + 8;
          if (chunkId === "fmt ") {
            if (size < 16 || dataStart + size > containerEnd) break;
            const fmt = new DataView(await blob.slice(dataStart, dataStart + 16).arrayBuffer());
            hasFormat = fmt.getUint16(0, true) > 0 && fmt.getUint16(2, true) > 0 &&
              fmt.getUint32(4, true) > 0 && fmt.getUint16(12, true) > 0 && fmt.getUint16(14, true) > 0;
          } else if (chunkId === "data") {
            const available = containerEnd - dataStart;
            hasAudioData = size > 0 && size <= available;
            if (hasFormat && hasAudioData) break;
          }
          const next = dataStart + size + (size & 1);
          if (next <= offset || next > containerEnd) break;
          offset = next;
        }
      }
      if (!container || !hasFormat || !hasAudioData)
        throw new Error("response is not a complete WAV file while fetching " + url);
    } else if (kind === "mp3") {
      const id3 = head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 &&
        head[3] >= 2 && head[3] <= 4 && head[4] !== 0xff &&
        head.slice(6, 10).every((byte) => byte < 0x80) &&
        10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]) <= blob.size;
      const mpegFrameLength = (bytes, offset) => {
        if (offset + 3 >= bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0)
          return 0;
        const versionBits = (bytes[offset + 1] >> 3) & 0x03;
        const layerBits = (bytes[offset + 1] >> 1) & 0x03;
        const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
        const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
        if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3)
          return 0;
        const version1 = versionBits === 3;
        const bitrates = version1
          ? (layerBits === 3
            ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
            : layerBits === 2
              ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
              : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])
          : (layerBits === 3
            ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
            : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]);
        const baseSampleRates = [44100, 48000, 32000];
        const sampleRate = baseSampleRates[sampleRateIndex] / (versionBits === 3 ? 1 : versionBits === 2 ? 2 : 4);
        const bitrate = bitrates[bitrateIndex - 1] * 1000;
        const padding = (bytes[offset + 2] >> 1) & 1;
        if (layerBits === 3) return Math.floor((12 * bitrate / sampleRate + padding) * 4);
        return Math.floor(((layerBits === 1 && !version1) ? 72 : 144) * bitrate / sampleRate + padding);
      };
      let audioOffset = 0;
      if (id3) {
        const tagSize = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
        const footerSize = head[3] === 4 && (head[5] & 0x10) ? 10 : 0;
        audioOffset = 10 + tagSize + footerSize;
      }
      const audioHead = audioOffset
        ? new Uint8Array(await blob.slice(audioOffset, Math.min(blob.size, audioOffset + 4096)).arrayBuffer())
        : head;
      const hasTwoFramesAt = (offset) => {
        const length = mpegFrameLength(audioHead, offset);
        const secondOffset = offset + length;
        const secondLength = length > 0 ? mpegFrameLength(audioHead, secondOffset) : 0;
        return secondLength > 0 && audioOffset + secondOffset + secondLength <= blob.size;
      };
      let frame = hasTwoFramesAt(0);
      // When encoders put a small non-ID3 preamble before audio, require two
      // frame headers at the exact calculated spacing. A lone sync-like pattern
      // inside arbitrary binary is far too common to identify an MP3 safely.
      for (let i = 1; !frame && i + 3 < audioHead.length; i++) {
        frame = hasTwoFramesAt(i);
      }
      if (!frame) throw new Error("response is not an MP3 file while fetching " + url);
    }
  };

  async function fetchBlob(url, kind) {
    const signal = operationController?.signal || instanceController.signal;
    for (let attempt = 0; attempt < 3; attempt++) {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      signal.addEventListener("abort", abortRequest, { once: true });
      if (signal.aborted) abortRequest();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, 60000);
      try {
        const requestAborted = new Promise((_, reject) => {
          const rejectOnAbort = () => {
            const error = new Error("download request aborted");
            error.name = "AbortError";
            reject(error);
          };
          requestController.signal.addEventListener("abort", rejectOnAbort, { once: true });
          if (requestController.signal.aborted) rejectOnAbort();
        });
        const res = await Promise.race([fetch(url, { signal: requestController.signal }), requestAborted]);
        // No Range request was sent, so a 206 body is necessarily only part of
        // the media even when its own Content-Length matches. Require the full
        // representation status rather than saving a plausible truncated file.
        if (res.status !== 200) {
          const error = new Error("HTTP " + res.status + " while fetching " + url);
          error.retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
          throw error;
        }
        const blob = await Promise.race([res.blob(), requestAborted]);
        const expected = Number(res.headers.get("content-length"));
        const contentEncoding = (res.headers.get("content-encoding") || "").trim().toLowerCase();
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        // Fetch exposes decoded response bytes, while Content-Length can describe
        // the encoded transfer. Compare sizes only when no content coding changed
        // the representation delivered to Blob.
        const comparableLength = !contentEncoding || contentEncoding === "identity";
        if (!blob.size || (comparableLength && Number.isFinite(expected) && expected > 0 && blob.size !== expected))
          throw new Error("incomplete response while fetching " + url);
        if (/^(text\/|application\/(?:json|xml))/.test(contentType)) {
          const error = new Error("unexpected " + contentType + " response while fetching " + url);
          error.retryable = false;
          throw error;
        }
        try {
          await validateMediaBlob(blob, contentType, kind, url);
        } catch (error) {
          error.retryable = false;
          throw error;
        }
        // A response implementation may ignore AbortSignal while reading or
        // validating its body. Re-check immediately before handing bytes to the
        // save path so Stop/re-paste cannot trigger a stale browser download.
        if (destroyed || stopRequested || signal.aborted) throw new Error("download stopped");
        return blob;
      } catch (err) {
        if (destroyed || stopRequested || signal.aborted)
          throw new Error("download stopped");
        if (attempt >= 2 || err?.retryable === false) throw err;
        const wait = 1000 * Math.pow(2, attempt);
        setStatus((timedOut ? "Download timed out" : "Download failed") +
          " - retrying in " + (wait / 1000) + "s...");
        await stopSleep(wait);
        if (destroyed || stopRequested || signal.aborted) throw new Error("download stopped");
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortRequest);
      }
    }
    throw new Error("download failed after retries");
  }

  async function fetchMp3(entry) {
    const fallback = `https://cdn1.suno.ai/${encodeURIComponent(String(entry.id))}.mp3`;
    const preferred = typeof entry.audioUrl === "string" ? entry.audioUrl : fallback;
    try {
      return await fetchBlob(preferred, "mp3");
    } catch (preferredError) {
      // Older caches have no audioUrl and continue to use the established CDN
      // convention. If a cached feed URL later expires, try that convention as
      // a compatibility fallback before reporting the song as failed.
      if (preferred === fallback || destroyed || stopRequested ||
          operationController?.signal.aborted || instanceController.signal.aborted)
        throw preferredError;
      try { return await fetchBlob(fallback, "mp3"); } catch { throw preferredError; }
    }
  }

  const parseWavStatus = (r) => {
    if (r.status === 404) return { state: "missing" };
    if (r.status !== 200) return { state: "error" };
    const value = r.j?.wav_file_url;
    if (typeof value === "string" && value.trim()) {
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error("wav_file returned an invalid URL"); }
      if (parsed.protocol !== "https:")
        throw new Error("wav_file returned an unsafe URL");
      return { state: "ready", url: parsed.href };
    }
    const conversionState = String(r.j?.state ?? r.j?.status ?? "").toLowerCase();
    if (["pending", "queued", "running", "processing", "in_progress"].includes(conversionState))
      return { state: "pending" };
    // An observed, known-compatible API response uses an empty object to mean
    // that no WAV exists yet.
    // Do not treat a non-empty, unknown 200 response as absence: it might be a
    // changed error/status shape, and POSTing then could spend credits needlessly.
    if (r.j && typeof r.j === "object" && !Array.isArray(r.j) && Object.keys(r.j).length === 0)
      return { state: "missing" };
    throw new Error("wav_file returned an unexpected response shape");
  };

  async function getWavUrl(id) {
    if (!operationOptions?.creditApproved) throw new Error("WAV conversion was not approved");
    const encodedId = encodeURIComponent(String(id));
    let r = await api("GET", `/api/gen/${encodedId}/wav_file/`);
    let wav = parseWavStatus(r);
    if (wav.state === "ready") return wav.url;
    if (wav.state === "error") throw new Error("wav_file " + r.status);
    const alreadyPending = wav.state === "pending";
    // A lost response is ambiguous: Suno may have accepted this paid conversion.
    // Never automatically resubmit it. One retry remains available only for the
    // explicit 401 path, which is known not to have run the conversion.
    if (!alreadyPending)
      r = await api("POST", `/api/gen/${encodedId}/convert_wav/`, null, 1, { retryAmbiguous: false });
    // A network failure or 5xx may happen after the paid request reached Suno.
    // Poll the read-only result endpoint in that ambiguous case, but never risk
    // a second conversion POST. Explicit 4xx responses are safe to surface.
    const ambiguous = !alreadyPending && (r.status === 0 || (r.status >= 500 && r.status <= 599));
    if (!alreadyPending) {
      if (!ambiguous && (r.status < 200 || r.status >= 300))
        throw new Error("convert_wav " + r.status + ": " + (r.j?.raw || r.j?.detail || "unexpected response"));
      // Some API versions return the finished URL directly from the conversion
      // request. Accept it without waiting for an extra status-poll interval.
      if (r.status >= 200 && r.status < 300 && typeof r.j?.wav_file_url === "string") {
        wav = parseWavStatus({ status: 200, j: { wav_file_url: r.j.wav_file_url } });
        return wav.url;
      }
    }
    for (let n = 0; n < 60; n++) {
      await stopSleep(5000);
      if (stopRequested) throw new Error("wav conversion stopped");
      r = await api("GET", `/api/gen/${encodedId}/wav_file/`);
      wav = parseWavStatus(r);
      if (wav.state === "ready") return wav.url;
      if (wav.state === "error") throw new Error("wav_file " + r.status);
    }
    throw new Error(ambiguous
      ? "WAV conversion result is still unknown after an ambiguous request; it was not resubmitted"
      : "wav conversion timed out");
  }

  // MIDI: GET /api/gen/{id}/midi/ returns {"state":"running"} then
  // {"state":"complete","instruments":[{name,is_drum,notes:[{pitch,start,end,velocity}]}]}
  async function getMidiData(id) {
    if (!operationOptions?.creditApproved) throw new Error("MIDI conversion was not approved");
    const encodedId = encodeURIComponent(String(id));
    for (let n = 0; n < 60; n++) {
      const r = await api("GET", `/api/gen/${encodedId}/midi/`);
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
      if (!instrument || typeof instrument !== "object" || !Array.isArray(instrument.notes))
        throw new Error("midi response contains an invalid instrument");
      const notes = instrument.notes;
      let channel;
      if (instrument.is_drum) channel = 9; // General MIDI percussion channel 10
      else {
        channel = melodicChannel++ % 15;
        if (channel >= 9) channel++;
      }
      for (const n of notes) {
        if (!n || typeof n !== "object") throw new Error("midi response contains an invalid note");
        const velocityValue = Number(n.velocity ?? 0.7);
        const pitchValue = Number(n.pitch ?? 60);
        const startValue = Number(n.start ?? 0);
        const endValue = Number(n.end ?? n.start ?? 0);
        if (![velocityValue, pitchValue, startValue, endValue].every(Number.isFinite))
          throw new Error("midi response contains non-numeric note data");
        const vel = Math.max(1, Math.min(127, Math.round(velocityValue * 127)));
        const pitch = Math.max(0, Math.min(127, Math.round(pitchValue)));
        const onT = Math.max(0, Math.round(startValue * ticksPerSec));
        const offT = Math.max(onT + 1, Math.round(endValue * ticksPerSec));
        // Standard MIDI variable-length quantities hold at most 28 bits. A
        // changed/malformed API response must fail rather than wrap its timing.
        if (onT > 0x0fffffff || offT > 0x0fffffff)
          throw new Error("midi response note time is out of range");
        events.push([onT, [0x90 | channel, pitch, vel]]);
        events.push([offT, [0x80 | channel, pitch, 0]]);
      }
    }
    events.sort((a, b) => {
      const time = a[0] - b[0];
      if (time) return time;
      // End an existing note before starting another one at the same tick. If
      // Suno returns notes out of order, note-on first would immediately silence
      // the replacement note on many MIDI players.
      const aOff = (a[1][0] & 0xf0) === 0x80;
      const bOff = (b[1][0] & 0xf0) === 0x80;
      if (aOff !== bOff) return aOff ? -1 : 1;
      return a[1][0] - b[1][0] || a[1][1] - b[1][1];
    });
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

  const collisionKey = (name) => sanitize(name).normalize("NFC").toLowerCase();
  const idFingerprint = (value) => {
    // Two independent 32-bit hashes keep the suffix portable and distinguish
    // IDs that a case-insensitive filesystem considers equal.
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  };
  const collisionSafeId = (entry, peers) => {
    const short = sanitize(entry.id.slice(0, 8));
    const conflicts = (tokenFor) => peers.some((candidate) =>
      candidate.id !== entry.id && collisionKey(tokenFor(candidate)) === collisionKey(tokenFor(entry))
    );
    if (!conflicts((candidate) => sanitize(candidate.id.slice(0, 8)))) return short;
    const full = sanitize(entry.id);
    if (!conflicts((candidate) => sanitize(candidate.id))) return full;
    return truncatePortable(full, 80) + "-" + idFingerprint(entry.id);
  };
  const withSuffix = (base, suffix) => {
    // Leave room for an extension under the usual 255-byte/code-unit component
    // limit. Keep the identifying suffix intact whenever it is reasonably sized.
    let tail = String(suffix);
    let tailSize = portableSize(tail);
    if (tailSize.bytes >= 220 || tailSize.codeUnits >= 220) {
      tail = truncatePortable(tail, 110);
      tailSize = portableSize(tail);
    }
    const head = truncatePortable(base,
      Math.max(1, 220 - tailSize.bytes),
      Math.max(1, 220 - tailSize.codeUnits)).replace(/[. ]+$/g, "") || "untitled";
    return head + tail;
  };
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
    if (entry.stemOutputBase) return sanitize(entry.stemOutputBase);
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

  function assignStableBases(entries, outputField, rawName, kind) {
    const groups = new Map();
    const usedByParent = new Map();
    for (const entry of entries) {
      const parentKey = String(entry.parentId || "");
      if (!usedByParent.has(parentKey)) usedByParent.set(parentKey, new Map());
      if (entry[outputField]) {
        entry[outputField] = sanitize(entry[outputField]);
        const key = collisionKey(entry[outputField]);
        const used = usedByParent.get(parentKey);
        if (used.has(key) && used.get(key) !== entry.id)
          throw new Error("cache contains colliding persisted " + kind + " filenames");
        used.set(key, entry.id);
      }
      const groupKey = parentKey + "\0" + collisionKey(rawName(entry));
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(entry);
    }
    let changed = false;
    for (const peers of groups.values()) {
      peers.sort((a, b) => a.id.localeCompare(b.id));
      const used = usedByParent.get(String(peers[0].parentId || ""));
      const base = sanitize(rawName(peers[0]));
      for (const entry of peers) {
        if (entry[outputField]) continue;
        let candidate = peers.length > 1 || used.has(collisionKey(base))
          ? withSuffix(base, " [" + collisionSafeId(entry, peers) + "]") : base;
        if (used.has(collisionKey(candidate)))
          candidate = withSuffix(base, " [" + idFingerprint(entry.id) + "]");
        if (used.has(collisionKey(candidate)))
          throw new Error("could not assign a collision-free " + kind + " filename");
        entry[outputField] = candidate;
        used.set(collisionKey(candidate), entry.id);
        changed = true;
      }
    }
    return changed;
  }

  function assignStableOutputBases() {
    const entries = [...scanState.songs.values()];
    const stemsChanged = assignStableBases(
      entries.filter((entry) => entry.isStem),
      "stemOutputBase", (entry) => entry.stemName || entry.title, "stem");
    const variationsChanged = assignStableBases(
      entries.filter((entry) => entry.isInfill),
      "variationOutputBase", (entry) => entry.title, "variation");
    return stemsChanged || variationsChanged;
  }

  const variationFileBase = (entry) => {
    if (entry.variationOutputBase) return sanitize(entry.variationOutputBase);
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
    // A parent may be absent from the selected feeds. Key the fallback directory
    // by that parent rather than by the child title: otherwise Vocals and Drums
    // belonging to one missing parent are incorrectly split into two song folders.
    const rawId = String(entry.parentId || entry.id);
    const peers = [...new Set([...scanState.songs.values()]
      .filter((candidate) => (candidate.isStem || candidate.isInfill) &&
        !scanState.songs.has(candidate.parentId))
      .map((candidate) => String(candidate.parentId || candidate.id)))];
    let token = sanitize(rawId);
    if (peers.some((peer) => peer !== rawId && collisionKey(peer) === collisionKey(rawId)))
      token = truncatePortable(token, 80) + "-" + idFingerprint(rawId);
    return withSuffix("Missing parent", " [" + token + "]");
  };

  // download() returns { files: "mp3+wav:fail+midi:skip", fails: 1 }
  async function download(entry, dir) {
    const { id, title, isStem, parentId } = entry;
    const clean = sanitize(title);
    const fmt = operationOptions?.formats || getFormats();
    const out = { files: [], fails: 0, errors: [] };
    const fail = (format, error) => {
      out.fails++;
      out.files.push(format + ":fail");
      out.errors.push(format.toUpperCase() + ": " + (error?.message || error));
    };
    const saveFallbackMp3 = async (name) => {
      try {
        const blob = await fetchMp3(entry);
        saveViaDownload(name + ".mp3", blob);
        out.files.push("mp3");
      } catch (e) { fail("mp3", e); }
    };
    const saveMp3 = async (d, name) => {
      if (await existsInFolder(d, name + ".mp3")) out.files.push("mp3:skip");
      else {
        try {
          const blob = await fetchMp3(entry);
          await saveToFolder(d, name + ".mp3", blob);
          out.files.push("mp3");
        } catch (e) { fail("mp3", e); }
      }
    };
    const saveWav = async (d, name) => {
      if (await existsInFolder(d, name + ".wav")) out.files.push("wav:skip");
      else {
        try {
          const url = await getWavUrl(id);
          const blob = await fetchBlob(url, "wav");
          await saveToFolder(d, name + ".wav", blob);
          out.files.push("wav");
        } catch (e) { fail("wav", e); }
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
        } catch (e) { fail("midi", e); }
      }
    };
    if (isStem) {
      const parentEntry = scanState.songs.get(parentId);
      const fname = stemFileBase(entry);
      // The stem option refers to existing stem audio, whose feed URL is MP3.
      // Honor it independently of the formats selected for full songs; this
      // never calls a stem-generation or conversion endpoint.
      if (operationOptions?.includeStems ?? includeStems()) {
        if (dir) {
          const parentFolder = await getOrCreateSubDir(dir, parentEntry ? folderFor(parentEntry) : orphanParentFolder(entry));
          const stemsDir = await getOrCreateSubDir(parentFolder, "stems");
          await saveMp3(stemsDir, fname);
        } else {
          const parent = sanitize(parentEntry?.title || "stem");
          // Browser-download mode has no directory hierarchy. One clip-ID
          // suffix is enough to distinguish both repeated and unique stems;
          // stemFileBase() may already have added one for folder mode.
          const fallbackStem = sanitize(entry.stemName || entry.title);
          await saveFallbackMp3(withSuffix(parent + " - " + fallbackStem, " [" +
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
          const fallbackVariation = sanitize(entry.title);
          await saveFallbackMp3(withSuffix(parent + " - " + fallbackVariation, " [" +
            collisionSafeId(entry, [...scanState.songs.values()]) + "]"));
        }
      }
      return out;
    }
    const songDir = await getOrCreateSubDir(dir, folderFor(entry));
    // Browser-download mode has one flat namespace. Always suffix normal songs,
    // otherwise a literal song title can collide with a synthesized stem or
    // variation name from the same scan.
    const fallbackBase = withSuffix(clean, " [" +
      collisionSafeId(entry, [...scanState.songs.values()]) + "]");
    if (fmt.mp3) {
      if (dir && await existsInFolder(songDir, clean + ".mp3")) out.files.push("mp3:skip");
      else if (!dir) {
        try {
          const blob = await fetchMp3(entry);
          saveViaDownload(fallbackBase + ".mp3", blob);
          out.files.push("mp3");
        } catch (e) { fail("mp3", e); }
      } else await saveMp3(songDir, clean);
    }
    if (fmt.wav) {
      if (dir && await existsInFolder(songDir, clean + ".wav")) out.files.push("wav:skip");
      else if (!dir) {
        try {
          const url = await getWavUrl(id);
          const blob = await fetchBlob(url, "wav");
          saveViaDownload(fallbackBase + ".wav", blob);
          out.files.push("wav");
        } catch (e) { fail("wav", e); }
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
      if (!Array.isArray(cached.songs))
        throw new Error("cache songs field is not an array");
      if (cached.seenIds !== undefined && !Array.isArray(cached.seenIds))
        throw new Error("cache seenIds field is not an array");
      if (cached.libDone !== undefined && typeof cached.libDone !== "boolean")
        throw new Error("cache libDone field is not a boolean");
      if (cached.wsDone !== undefined && typeof cached.wsDone !== "boolean")
        throw new Error("cache wsDone field is not a boolean");
      if (cached.stemsIncluded !== undefined && typeof cached.stemsIncluded !== "boolean")
        throw new Error("cache stemsIncluded field is not a boolean");
      if (cached.libCursor !== undefined && !validCursor(cached.libCursor))
        throw new Error("cache libCursor field is invalid");
      if (cached.wsCursor !== undefined && !validCursor(cached.wsCursor))
        throw new Error("cache wsCursor field is invalid");
      if (cached.scanned !== undefined &&
          (!Number.isInteger(cached.scanned) || cached.scanned < 0))
        throw new Error("cache scanned field is not a non-negative integer");
      const hasIncludeLibrary = cached.includeLibrary !== undefined;
      const hasIncludeWorkspace = cached.includeWorkspace !== undefined;
      if (hasIncludeLibrary !== hasIncludeWorkspace)
        throw new Error("cache feed selection fields are incomplete");
      if (hasIncludeLibrary && (typeof cached.includeLibrary !== "boolean" ||
          typeof cached.includeWorkspace !== "boolean"))
        throw new Error("cache feed selection fields are not boolean");
      if ((cached.songs || []).some((song) => !song || typeof song !== "object" || !validClipId(song.id)))
        throw new Error("cache contains an invalid song entry");
      if (new Set(cached.songs.map((song) => song.id)).size !== cached.songs.length)
        throw new Error("cache contains duplicate song IDs");
      if ((cached.songs || []).some((song) => song.stemOutputBase !== undefined &&
          typeof song.stemOutputBase !== "string"))
        throw new Error("cache contains an invalid persisted stem filename");
      if ((cached.songs || []).some((song) => song.variationOutputBase !== undefined &&
          typeof song.variationOutputBase !== "string"))
        throw new Error("cache contains an invalid persisted variation filename");
      if ((cached.seenIds || []).some((id) => !validClipId(id)))
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
      includeLibrary: INCLUDE_LIBRARY,
      includeWorkspace: INCLUDE_WORKSPACE,
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
    scanState.libDone = !INCLUDE_LIBRARY || !!cached.libDone;
    scanState.wsDone = !INCLUDE_WORKSPACE || !!cached.wsDone;
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
    scanState.libDone = !INCLUDE_LIBRARY;
    scanState.wsDone = !INCLUDE_WORKSPACE;
    scanState.stemsIncluded = false;
    scanState.scanned = 0;
  }

  async function enumerateSongs(dir) {
    setStatus("Enumerating songs...");
    // This flag means every page contributing to a completed cache included
    // stems. Resuming a partial stem scan with stems disabled must downgrade it;
    // otherwise a later stem run would trust an incomplete stem collection.
    scanState.stemsIncluded = includeStems();
    const onProgress = (msg) => setStatus(msg);
    const scans = await Promise.allSettled([
      getLibrary(dir, onProgress, persistCache),
      getWorkspace(dir, onProgress, persistCache),
    ]);
    const failedScan = scans.find((result) => result.status === "rejected");
    if (failedScan) throw failedScan.reason;
    assignStableOutputBases();
    await persistCache(dir);
    let out = [...scanState.songs.values()];
    if (!includeStems()) out = out.filter((s) => !s.isStem);
    if (LIMIT > 0) out.splice(LIMIT);
    return { songs: out };
  }

  // ---------- flow ----------
  const usePicker = typeof window.showDirectoryPicker === "function";
  if (!usePicker) {
    pickBtn.disabled = true;
    pickBtn.textContent = "Folder picker unavailable (browser downloads)";
    setStatus("Files will use your browser's normal download behavior.");
  }
  let songs = [];
  let rescan = false;
  let pickedDir = null;
  let songsDir = null;
  let songsIncludedStems = null;

  async function ensureSongs(dir) {
    const wantsStems = includeStems();
    if (songs.length && !rescan && songsDir === dir && songsIncludedStems === wantsStems) return true;
    const cached = await readCache(dir);
    if (operationCancelled()) {
      setStatus("Stopped before scanning.");
      return false;
    }
    const cacheIncludedStems = cached && (typeof cached.stemsIncluded === "boolean"
      ? cached.stemsIncluded
      : (cached.songs || []).some((s) => s.isStem));
    const needStemRescan = cached && includeStems() && !cacheIncludedStems;
    const needFeedRescan = cached && !cacheMatchesFeedSelection(cached);
    if (cached && !rescan && !needStemRescan && !needFeedRescan && cached.libDone && cached.wsDone) {
      restoreScanState(cached);
      if (assignStableOutputBases()) await persistCache(dir);
      if (operationCancelled()) {
        setStatus("Stopped before downloading.");
        return false;
      }
      songs = [...scanState.songs.values()];
      if (!includeStems()) songs = songs.filter((s) => !s.isStem);
      if (LIMIT > 0) songs = songs.slice(0, LIMIT);
      songsDir = dir;
      songsIncludedStems = wantsStems;
      setStatus(`Using cache: ${songs.length} download items.\nStarting download...`);
      return true;
    }
    earlyStopLibrary = false; // normal/partial-cache scans resume from their saved cursors
    earlyStopWorkspace = false;
    if (cached && !needFeedRescan) restoreScanState(cached);
    else resetScanState();
    if (needStemRescan && !needFeedRescan) {
      // force a full re-walk so stems get collected (done flags from cache would skip it)
      scanState.songs = new Map();
      scanState.seenIds = new Set();
      scanState.libCursor = null;
      scanState.wsCursor = null;
      scanState.libDone = !INCLUDE_LIBRARY;
      scanState.wsDone = !INCLUDE_WORKSPACE;
      scanState.stemsIncluded = true;
    }
    const { songs: fresh } = await enumerateSongs(dir);
    if (stopRequested) { setStatus("Scan stopped. Progress saved - rerun to resume."); return false; }
    songs = fresh;
    songsDir = dir;
    songsIncludedStems = wantsStems;
    if (!songs.length) { setStatus("No songs found."); return false; }
    setStatus(`Found ${songs.length} download items${includeStems() ? " (songs and stems)" : ""}.\nStarting download...`);
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
  const setBusy = (isBusy, canStop = isBusy) => {
    // Set the guard before any awaited picker/API call so rapid clicks cannot
    // start overlapping scans or downloads.
    busy = isBusy;
    startBtn.disabled = isBusy;
    stopBtn.disabled = !canStop;
    pickBtn.disabled = isBusy || !usePicker;
    for (const cb of [mp3Check, wavCheck, midiCheck, stemsCheck]) cb.disabled = isBusy;
    if (rescanLink) {
      rescanLink.setAttribute("aria-disabled", String(isBusy));
      rescanLink.style.pointerEvents = isBusy ? "none" : "auto";
      rescanLink.style.opacity = isBusy ? "0.5" : "1";
    }
  };

  // choose folder only (does not start)
  pickBtn.addEventListener("click", () => trackTask((async () => {
    if (!usePicker || busy || destroyed) return;
    setBusy(true, false);
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
      setStatus(e?.name === "AbortError"
        ? "Folder picker cancelled."
        : "Folder picker failed: " + (e?.message || e));
    } finally {
      setBusy(false);
    }
  })()));

  // start downloads (scans first if no cache)
  startBtn.addEventListener("click", () => trackTask((async () => {
    if (busy || destroyed) return;
    operationOptions = {
      formats: getFormats(),
      includeStems: stemsCheck.checked || INCLUDE_STEMS,
      creditApproved: false,
    };
    if (!operationOptions.formats.mp3 && !operationOptions.formats.wav &&
        !operationOptions.formats.midi && !operationOptions.includeStems) {
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
        catch (e) {
          setStatus(e?.name === "AbortError"
            ? "Folder picker cancelled."
            : "Folder picker failed: " + (e?.message || e));
          return;
        }
        if (destroyed) return;
        pickedDir = dir;
      }
      if (stopRequested) { setStatus("Stopped before scanning."); return; }
      if (!(await ensureSongs(dir))) return;
      if (operationCancelled()) { setStatus("Stopped before downloading."); return; }
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
      const runErrors = [];
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
          for (const message of r.errors || []) runErrors.push(e.title + " - " + message);
          setStatus(`[${i + 1}/${songs.length}] ${files}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
        } catch (err) {
          failed++;
          runErrors.push(e.title + " - " + (err?.message || err));
          setStatus(`[${i + 1}/${songs.length}] FAILED: ${err.message}\n${ok} downloaded, ${skipped} skipped, ${failed} failed`);
        }
        if (i < songs.length - 1) await stopSleep(PAUSE_MS);
      }
      const summary = stopRequested
        ? `Stopped. ${ok} downloaded, ${skipped} skipped, ${failed} failed. Rerun to resume.`
        : `Done. ${ok} downloaded, ${skipped} skipped, ${failed} failed.`;
      const details = runErrors.length
        ? "\nErrors:\n" + runErrors.slice(0, 5).join("\n") +
          (runErrors.length > 5 ? `\n...and ${runErrors.length - 5} more.` : "")
        : "";
      setStatus(summary + details);
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
  })()));

  // small re-scan link so new songs get picked up without deleting the cache
  if (usePicker) {
    const link = document.createElement("a");
    rescanLink = link;
    link.textContent = "Re-scan for new songs";
    link.style.cssText = "display:block;margin-top:8px;color:#ff6b9d;cursor:pointer;font-size:12px;text-decoration:underline";
    link.addEventListener("click", () => trackTask((async () => {
      if (busy || destroyed) return;
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
        const feedSelectionMatches = cacheMatchesFeedSelection(cached);
        resetScanState();
        scanState.stemsIncluded = !!(cached && feedSelectionMatches && (typeof cached.stemsIncluded === "boolean"
          ? cached.stemsIncluded
          : (cached.songs || []).some((s) => s.isStem)));
        // If this cache predates a stem-inclusive scan, walk every page once;
        // seenIds also contains excluded stems and is not a safe early boundary.
        const canEarlyStop = scanState.stemsIncluded || !includeStems();
        // A partial cache only proves that its already-seen newest pages are
        // known; older pages may never have been scanned. Apply the newest-first
        // early boundary separately, and only to feeds previously completed.
        earlyStopLibrary = feedSelectionMatches && canEarlyStop && cached?.libDone === true;
        earlyStopWorkspace = feedSelectionMatches && canEarlyStop && cached?.wsDone === true;
        knownBeforeRescan = new Set(feedSelectionMatches ? (cached?.seenIds || []) : []);
        if (cached && feedSelectionMatches && cached.songs) {
          // seed from cache so the early-stop boundary knows what's already seen,
          // but keep done flags false so feeds actually re-walk
          for (const s of cached.songs) scanState.songs.set(s.id, s);
          for (const id of cached.seenIds || []) scanState.seenIds.add(id);
          // Freeze legacy unsuffixed stem paths before discovering new peers.
          // A later duplicate then receives a suffix without renaming the file
          // that an earlier run already downloaded.
          assignStableOutputBases();
        }
        const { songs: fresh } = await enumerateSongs(dir);
        if (stopRequested) {
          rescan = false;
          earlyStopLibrary = false;
          earlyStopWorkspace = false;
          setStatus("Re-scan stopped. Progress saved - rerun to resume.");
          return;
        }
        songs = fresh;
        songsDir = dir;
        songsIncludedStems = includeStems();
        rescan = false;
        earlyStopLibrary = false;
        earlyStopWorkspace = false;
        knownBeforeRescan = new Set();
        setStatus(`Re-scan complete: ${songs.length} download items.\nClick "Start" to download.`);
      } catch (e) {
        rescan = false;
        earlyStopLibrary = false;
        earlyStopWorkspace = false;
        setStatus(e?.name === "AbortError"
          ? "Re-scan cancelled."
          : "Re-scan failed: " + (e?.message || e));
      } finally {
        operationController?.abort();
        operationController = null;
        operationOptions = null;
        knownBeforeRescan = new Set();
        stopRequested = false;
        setBusy(false);
      }
    })()));
    panel.appendChild(link);
  }

  for (const cb of [mp3Check, wavCheck, midiCheck, stemsCheck]) {
    cb.addEventListener("change", () => {
      trackTask(refreshCredits()).catch((err) => {
        if (!destroyed) creditsBox.textContent = "Could not read credit balance: " + (err?.message || err);
      });
    });
  }
  trackTask(refreshCredits()).catch((err) => {
    if (!destroyed) creditsBox.textContent = "Could not read credit balance: " + (err?.message || err);
  });
})();
