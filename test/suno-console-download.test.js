"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(__dirname, "..", "suno-console-download.js");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8")
  .replace("const PAUSE_MS = 1500", "const PAUSE_MS = 0");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class MockElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = "";
    this.textContent = "";
    this.disabled = false;
    this.checked = false;
  }

  set innerHTML(html) {
    this.children = [];
    for (const match of html.matchAll(/<(input|button|div)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const child = new MockElement(match[1], this.ownerDocument);
      child.id = match[2];
      this.appendChild(child);
    }
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  querySelector(selector) {
    return this.ownerDocument.find(selector, this);
  }

  querySelectorAll(selector) {
    return this.ownerDocument.findAll(selector, this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    if (this.disabled) return;
    if (this.tagName === "A" && this.download) this.ownerDocument.downloads.push(this.download);
    for (const listener of this.listeners.get("click") || []) listener.call(this, { type: "click", target: this });
  }

  dispatchChange() {
    for (const listener of this.listeners.get("change") || []) listener.call(this, { type: "change", target: this });
  }
}

class MockDocument {
  constructor() {
    this.downloads = [];
    this.body = new MockElement("body", this);
  }

  createElement(tagName) {
    return new MockElement(tagName, this);
  }

  walk(root = this.body) {
    const result = [];
    for (const child of root.children) result.push(child, ...this.walk(child));
    return result;
  }

  findAll(selector, root = this.body) {
    if (!selector.startsWith("#")) throw new Error("Mock only supports id selectors");
    const id = selector.slice(1);
    return this.walk(root).filter((element) => element.id === id);
  }

  find(selector, root = this.body) {
    return this.findAll(selector, root)[0] || null;
  }

  querySelectorAll(selector) {
    return this.findAll(selector);
  }

  getElementById(id) {
    return this.find("#" + id);
  }
}

class MemoryFile {
  constructor(content = "") {
    this.blob = content instanceof Blob ? content : new Blob([content]);
    this.failWrite = false;
  }

  async getFile() {
    return this.blob;
  }

  async createWritable() {
    if (this.failWrite) throw new Error("mock write denied");
    let pending = this.blob;
    return {
      write: async (content) => { pending = content instanceof Blob ? content : new Blob([content]); },
      close: async () => { this.blob = pending; },
      abort: async () => {},
    };
  }
}

class MemoryDirectory {
  constructor(name = "root") {
    this.name = name;
    this.files = new Map();
    this.directories = new Map();
    this.failCacheWrites = false;
  }

  seed(name, content) {
    this.files.set(name, new MemoryFile(content));
    return this;
  }

  async getFileHandle(name, options = {}) {
    let file = this.files.get(name);
    if (!file && options.create) {
      file = new MemoryFile();
      if (name === "suno-cache.json" && this.failCacheWrites) file.failWrite = true;
      this.files.set(name, file);
    }
    if (!file) {
      const error = new Error("File not found: " + name);
      error.name = "NotFoundError";
      throw error;
    }
    return file;
  }

  async getDirectoryHandle(name, options = {}) {
    let directory = this.directories.get(name);
    if (!directory && options.create) {
      directory = new MemoryDirectory(name);
      this.directories.set(name, directory);
    }
    if (!directory) {
      const error = new Error("Directory not found: " + name);
      error.name = "NotFoundError";
      throw error;
    }
    return directory;
  }

  paths(prefix = "") {
    const result = [...this.files.keys()].map((name) => prefix + name);
    for (const [name, directory] of this.directories) {
      result.push(...directory.paths(prefix + name + "/"));
    }
    return result.sort();
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createRuntime(options = {}) {
  const document = new MockDocument();
  const calls = [];
  const confirms = [];
  let pickerCalls = 0;
  const directory = options.directory || new MemoryDirectory();
  const fetchImpl = options.fetch || (async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 123, running_jobs_cost: 0 });
    if (String(url).endsWith("/api/feed/v3")) return jsonResponse({ clips: options.libraryClips || [], has_more: false, next_cursor: null });
    if (String(url).includes("/api/project/feed")) return jsonResponse({ items: options.workspaceItems || [], next_cursor: null });
    if (String(url).startsWith("https://cdn1.suno.ai/")) return new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    throw new Error("Unexpected fetch: " + url);
  });
  const TrackedURL = class extends URL {};
  TrackedURL.createObjectURL = () => "blob:mock";
  TrackedURL.revokeObjectURL = () => {};
  const sandbox = {
    document,
    console,
    Blob,
    Response,
    AbortController,
    URL: TrackedURL,
    Clerk: { session: { getToken: async () => "mock-token" } },
    fetch: (url, init) => fetchImpl(url, init),
    confirm: (message) => {
      confirms.push(message);
      return typeof options.confirm === "function" ? options.confirm(message) : (options.confirm ?? true);
    },
    setTimeout: (callback, ms) => {
      if (ms >= 30000 && !options.fireLongTimers) return { ignored: true };
      return setTimeout(callback, options.timerDelay ?? 0);
    },
    clearTimeout: (id) => { if (id && !id.ignored) clearTimeout(id); },
  };
  sandbox.window = sandbox;
  if (options.usePicker !== false) {
    sandbox.showDirectoryPicker = async () => {
      pickerCalls++;
      return options.pick ? options.pick() : directory;
    };
  }
  const context = vm.createContext(sandbox);
  return {
    context,
    document,
    directory,
    calls,
    confirms,
    get pickerCalls() { return pickerCalls; },
    run() { vm.runInContext(SCRIPT, context, { filename: SCRIPT_PATH }); },
    element(id) { return document.getElementById(id); },
    status() { return document.getElementById("suno-dl-status")?.textContent || ""; },
  };
}

function completeCache(songs, extra = {}) {
  return JSON.stringify({
    savedAt: 1,
    libCursor: null,
    wsCursor: null,
    libDone: true,
    wsDone: true,
    songs,
    seenIds: songs.map((song) => song.id),
    scanned: songs.length,
    ...extra,
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("initializes one panel and re-paste destroys the old instance", async () => {
  const runtime = createRuntime();
  runtime.run();
  const oldPanel = runtime.element("suno-bulk-downloader-panel");
  assert.ok(oldPanel);
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 1);
  runtime.run();
  await tick();
  assert.equal(oldPanel.parentNode, null);
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 1);
});

test("re-paste aborts an old in-flight scan before it can overlap", async () => {
  let feedAttempts = 0;
  const runtime = createRuntime({
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      if (url.endsWith("/api/feed/v3")) {
        feedAttempts++;
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => feedAttempts === 1, "old scan did not start");
  runtime.run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(feedAttempts, 1);
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 1);
});

test("re-paste waits for an old in-flight file write before initializing", async () => {
  let releaseClose;
  let writeStarted = false;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  class HoldingDirectory extends MemoryDirectory {
    async getDirectoryHandle(name, options = {}) {
      let directory = this.directories.get(name);
      if (!directory && options.create) {
        directory = new HoldingDirectory(name);
        this.directories.set(name, directory);
      }
      if (!directory) return super.getDirectoryHandle(name, options);
      return directory;
    }

    async getFileHandle(name, options = {}) {
      const file = await super.getFileHandle(name, options);
      if (name.endsWith(".mp3") && !file.holdsClose) {
        file.holdsClose = true;
        file.createWritable = async () => {
          let pending = file.blob;
          return {
            write: async (content) => {
              pending = content instanceof Blob ? content : new Blob([content]);
              writeStarted = true;
            },
            close: async () => { await closeGate; file.blob = pending; },
            abort: async () => {},
          };
        };
      }
      return file;
    }
  }
  const directory = new HoldingDirectory().seed("suno-cache.json", completeCache([
    { id: "write0000001", title: "Held write" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => writeStarted, "file write did not start");
  runtime.run();
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 0,
    "replacement panel initialized before the old write settled");
  runtime.run();
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 0,
    "newest replacement did not wait for an already-pending replacement");
  releaseClose();
  await waitFor(() => runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length === 1,
    "replacement panel did not initialize after the old write settled");
  await tick();
  assert.equal(runtime.calls.filter((call) => call.url.endsWith("/api/billing/credits")).length, 2,
    "an intermediate replacement initialized alongside the newest paste");
});

test("re-paste waits for a pending file handle and prevents the stale write", async () => {
  let releaseHandle;
  let handleRequested = false;
  const handleGate = new Promise((resolve) => { releaseHandle = resolve; });
  class HoldingDirectory extends MemoryDirectory {
    async getDirectoryHandle(name, options = {}) {
      let directory = this.directories.get(name);
      if (!directory && options.create) {
        directory = new HoldingDirectory(name);
        this.directories.set(name, directory);
      }
      if (!directory) return super.getDirectoryHandle(name, options);
      return directory;
    }

    async getFileHandle(name, options = {}) {
      if (name.endsWith(".mp3")) {
        handleRequested = true;
        await handleGate;
      }
      return super.getFileHandle(name, options);
    }
  }
  const directory = new HoldingDirectory().seed("suno-cache.json", completeCache([
    { id: "handle000001", title: "Held handle" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => handleRequested, "file handle request did not start");
  runtime.run();
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 0,
    "replacement panel initialized while an old file handle was pending");
  releaseHandle();
  await waitFor(() => runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length === 1,
    "replacement panel did not initialize after the old save settled");
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false,
    "destroyed instance wrote a file after replacement");
});

test("busy operations lock formats, folder selection, Start, and re-scan", async () => {
  let resolvePicker;
  const picker = new Promise((resolve) => { resolvePicker = resolve; });
  const runtime = createRuntime({ pick: () => picker });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  for (const id of ["suno-dl-mp3", "suno-dl-wav", "suno-dl-midi", "suno-dl-stems", "suno-dl-pick", "suno-dl-btn"])
    assert.equal(runtime.element(id).disabled, true, id + " should be disabled");
  const rescan = runtime.document.walk().find((element) => element.textContent === "Re-scan for new songs");
  assert.equal(rescan.getAttribute("aria-disabled"), "true");
  assert.equal(rescan.style.pointerEvents, "none");
  rescan.click();
  assert.equal(runtime.pickerCalls, 1, "re-scan must not open a second picker while busy");
  resolvePicker(runtime.directory);
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "operation did not leave busy state");
});

for (const format of ["wav", "midi"]) {
  test(format.toUpperCase() + " credit warning uses the operation snapshot and blocks conversion", async () => {
    const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
      { id: "song00000001", title: "One" },
    ]));
    const runtime = createRuntime({ directory, confirm: false });
    runtime.run();
    runtime.element("suno-dl-mp3").checked = false;
    runtime.element("suno-dl-" + format).checked = true;
    runtime.element("suno-dl-btn").click();
    // A script or extension mutating the checkbox after Start must not alter
    // the frozen options or evade the confirmation gate.
    runtime.element("suno-dl-" + format).checked = false;
    await waitFor(() => runtime.status() === "Cancelled.", "credit confirmation was not reached");
    assert.equal(runtime.confirms.length, 1);
    assert.match(runtime.confirms[0], /use your Suno credits/i);
    assert.equal(runtime.calls.some((call) => /convert_wav|\/midi\//.test(call.url)), false);
  });
}

test("an ambiguous WAV conversion request is polled without a second paid POST", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "wavambiguous1", title: "Ambiguous WAV" },
  ]));
  let wavChecks = 0;
  let convertPosts = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url, init });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 100 });
      if (url.includes("/api/gen/wavambiguous1/wav_file/")) {
        wavChecks++;
        return wavChecks === 1
          ? jsonResponse({ detail: "not ready" }, 404)
          : jsonResponse({ wav_file_url: "https://cdn.example/ready.wav" });
      }
      if (url.includes("/api/gen/wavambiguous1/convert_wav/")) {
        convertPosts++;
        throw new TypeError("connection lost after request upload");
      }
      if (url === "https://cdn.example/ready.wav")
        return new Response(new Blob(["wav"]), { status: 200, headers: { "content-type": "audio/wav" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "ambiguous WAV recovery did not finish", 3000);
  assert.equal(convertPosts, 1, "ambiguous paid request must never be resubmitted");
  assert.ok(wavChecks >= 2, "read-only WAV result was not polled");
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
  assert.ok(directory.paths().some((name) => name.endsWith("Ambiguous WAV.wav")));
});

test("old complete caches remain usable without a feed scan", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "legacy000001", title: "Legacy song" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "legacy-cache download did not finish");
  assert.equal(runtime.calls.some((call) => call.url.includes("/api/feed/v3") || call.url.includes("/api/project/feed")), false);
  assert.ok(directory.paths().some((name) => name.endsWith("Legacy song.mp3")));
});

test("malformed caches are reported and are not silently overwritten", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", "{ definitely not json");
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /cache|json/i.test(runtime.status()), "malformed cache failure was not shown");
  assert.equal(runtime.calls.some((call) => call.url.includes("/api/feed/v3") || call.url.includes("/api/project/feed")), false);
  assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), "{ definitely not json");
});

test("non-boolean cache completion flags are rejected instead of bypassing a scan", async () => {
  const original = JSON.stringify({ songs: [], seenIds: [], libDone: "false", wsDone: true });
  const directory = new MemoryDirectory().seed("suno-cache.json", original);
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /libDone.*boolean/i.test(runtime.status()), "invalid done flag was not reported");
  assert.equal(runtime.calls.some((call) => call.url.includes("/api/feed/v3")), false);
  assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
});

test("a cache missing its song list is rejected instead of treated as an empty library", async () => {
  const original = JSON.stringify({ seenIds: [], libDone: true, wsDone: true });
  const directory = new MemoryDirectory().seed("suno-cache.json", original);
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /songs.*array/i.test(runtime.status()), "missing song list was not reported");
  assert.equal(runtime.calls.some((call) => /\/api\/(feed\/v3|project\/feed)/.test(call.url)), false);
  assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
});

test("resuming a partial stem scan without stems downgrades the completed cache", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "oldstem00001", title: "Vocals", isStem: true, parentId: "parent000001", stemName: "Vocals" },
  ], {
    stemsIncluded: true,
    libDone: false,
    libCursor: "resume-cursor",
    wsDone: true,
  }));
  const runtime = createRuntime({
    directory,
    libraryClips: [{ id: "song00000001", title: "Song", status: "complete", metadata: {} }],
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "partial-cache resume did not finish");
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.libDone, true);
  assert.equal(cache.stemsIncluded, false,
    "cache must not claim complete stem coverage after pages were scanned with stems disabled");
});

test("cache write failures are visible and prevent downloading an unresumable scan", async () => {
  const directory = new MemoryDirectory();
  directory.failCacheWrites = true;
  const runtime = createRuntime({
    directory,
    libraryClips: [{ id: "song00000001", title: "One", status: "complete", metadata: {} }],
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /could not save suno-cache\.json/i.test(runtime.status()), "cache write failure was not shown");
  assert.equal(runtime.calls.some((call) => call.url.startsWith("https://cdn1.suno.ai/")), false);
});

test("network retries terminate and restore the UI", async () => {
  let feedAttempts = 0;
  const runtime = createRuntime({
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) { feedAttempts++; throw new TypeError("offline"); }
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => feedAttempts === 6, "network retries did not reach their finite limit", 5000);
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "network failure did not restore the UI", 5000);
  assert.match(runtime.status(), /^Error: library feed error 0/);
  assert.equal(feedAttempts, 6);
  assert.equal(runtime.element("suno-dl-btn").disabled, false);
});

test("a hung authentication token request times out and restores the UI", async () => {
  const runtime = createRuntime({ fireLongTimers: true });
  runtime.context.Clerk.session.getToken = async () => new Promise(() => {});
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled,
    "hung authentication did not restore the UI", 5000);
  assert.match(runtime.status(), /^Error: library feed error 0: request timed out after retries/);
  assert.equal(runtime.calls.length, 0, "a request was sent without an authentication token");
});

test("Stop cancels a rate-limit retry before another request", async () => {
  let feedAttempts = 0;
  const runtime = createRuntime({
    timerDelay: 2,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) { feedAttempts++; return jsonResponse({ detail: "slow down" }, 429); }
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => feedAttempts === 1, "first rate-limited request was not made");
  const stop = runtime.document.walk().find((element) => element.textContent === "Stop");
  stop.click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "Stop did not settle the operation");
  assert.equal(feedAttempts, 1);
});

test("duplicate stems and variations receive stable collision-free names", async () => {
  const songs = [
    { id: "parent000001", title: "Parent" },
    { id: "stem0000001", title: "Vocals", isStem: true, parentId: "parent000001", stemName: "Vocals" },
    // Windows and default macOS filesystems are case-insensitive. These are a
    // duplicate output name even though JavaScript string comparison differs.
    { id: "stem0000002", title: "vocals", isStem: true, parentId: "parent000001", stemName: "vocals" },
    { id: "edit0000001", title: "[00:10 - 00:20] verse", isInfill: true, parentId: "parent000001" },
    { id: "edit0000002", title: "[00:10 - 00:20] VERSE", isInfill: true, parentId: "parent000001" },
  ];
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache(songs, { stemsIncluded: true }));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "duplicate download did not finish", 3000);
  const media = directory.paths().filter((name) => name.endsWith(".mp3"));
  const stems = media.filter((name) => name.includes("/stems/"));
  const variations = media.filter((name) => name.includes("/variations/"));
  assert.equal(stems.length, 2, stems.join("\n"));
  assert.equal(new Set(stems.map((name) => name.toLowerCase())).size, 2);
  assert.equal(variations.length, 2, variations.join("\n"));
  assert.equal(new Set(variations.map((name) => name.toLowerCase())).size, 2);
});

test("a 200 response with an unexpected feed shape is not cached as a complete scan", async () => {
  const directory = new MemoryDirectory();
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({ detail: "new response shape" });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "unexpected feed shape did not settle");
  assert.match(runtime.status(), /^Error: library feed error/i);
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.notEqual(cache.libDone, true);
});

test("a 200 response with an unexpected workspace shape is not cached as complete", async () => {
  const directory = new MemoryDirectory();
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({ clips: [], has_more: false, next_cursor: null });
      if (url.includes("/api/project/feed")) return jsonResponse({ detail: "new response shape" });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "unexpected workspace shape did not settle");
  assert.match(runtime.status(), /^Error: project feed error/i);
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.notEqual(cache.wsDone, true);
});

test("empty successful CDN responses are rejected rather than counted as downloads", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "empty0000001", title: "Empty response" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/")) return new Response(new Blob([]), { status: 200 });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "empty CDN test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("CDN retries are finite and recover a transient download failure", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "retrycdn0001", title: "Retry CDN" },
  ]));
  let cdnAttempts = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/")) {
        cdnAttempts++;
        if (cdnAttempts < 3) throw new TypeError("transient CDN failure");
        return new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "CDN retry test did not finish", 3000);
  assert.equal(cdnAttempts, 3);
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
});

test("an existing-file probe failure cannot overwrite a possibly existing download", async () => {
  let writableCalls = 0;
  class ProtectedDirectory extends MemoryDirectory {
    async getDirectoryHandle(name, options = {}) {
      let directory = this.directories.get(name);
      if (!directory && options.create) {
        directory = new ProtectedDirectory(name);
        this.directories.set(name, directory);
      }
      if (!directory) return super.getDirectoryHandle(name, options);
      return directory;
    }

    async getFileHandle(name, options = {}) {
      if (name.endsWith(".mp3")) {
        return {
          getFile: async () => {
            const error = new Error("mock permission denied");
            error.name = "NotAllowedError";
            throw error;
          },
          createWritable: async () => {
            writableCalls++;
            throw new Error("must not open a writable after an ambiguous probe failure");
          },
        };
      }
      return super.getFileHandle(name, options);
    }
  }
  const directory = new ProtectedDirectory().seed("suno-cache.json", completeCache([
    { id: "protected001", title: "Protected" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "probe-failure test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(writableCalls, 0);
  assert.equal(runtime.calls.some((call) => call.url.startsWith("https://cdn1.suno.ai/")), false);
});

test("MIDI drum instruments use channel 10 and melodic instruments avoid it", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "midi00000001", title: "MIDI channels" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.includes("/api/gen/midi00000001/midi/")) return jsonResponse({
        state: "complete",
        instruments: [
          { name: "Drums", is_drum: true, notes: [{ pitch: 36, start: 0, end: 0.1, velocity: 0.8 }] },
          { name: "Piano", is_drum: false, notes: [{ pitch: 60, start: 0, end: 0.1, velocity: 0.8 }] },
        ],
      });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-midi").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "MIDI channel test did not finish");
  const midiPath = directory.paths().find((name) => name.endsWith(".mid"));
  assert.ok(midiPath);
  const songDir = directory.directories.values().next().value;
  const midiFile = [...songDir.files.entries()].find(([name]) => name.endsWith(".mid"))[1];
  const bytes = new Uint8Array(await midiFile.blob.arrayBuffer());
  assert.ok(bytes.some((byte, index) => byte === 0x99 && bytes[index + 1] === 36), "drum note-on was not on MIDI channel 10");
  assert.ok(bytes.some((byte, index) => byte === 0x90 && bytes[index + 1] === 60), "melodic note-on was not on a non-drum channel");
});

test("malformed MIDI note data fails instead of writing a corrupt file", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "badmidi00001", title: "Bad MIDI" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.includes("/api/gen/badmidi00001/midi/")) return jsonResponse({
        state: "complete",
        instruments: [{ name: "Piano", is_drum: false, notes: [
          { pitch: 60, start: "not-a-time", end: 1, velocity: 0.8 },
        ] }],
      });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-midi").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "malformed MIDI test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mid")), false);
});

test("fallback downloads disambiguate duplicate song titles", async () => {
  const runtime = createRuntime({
    usePicker: false,
    libraryClips: [
      { id: "song00000001", title: "Same title", status: "complete", metadata: {} },
      { id: "song00000002", title: "same title", status: "complete", metadata: {} },
    ],
  });
  runtime.run();
  assert.equal(runtime.element("suno-dl-pick").disabled, true);
  assert.match(runtime.element("suno-dl-pick").textContent, /browser downloads/i);
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "fallback download did not finish", 3000);
  assert.equal(runtime.document.downloads.length, 2);
  assert.equal(new Set(runtime.document.downloads.map((name) => name.toLowerCase())).size, 2);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (error) {
      failed++;
      console.error("not ok - " + name);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
