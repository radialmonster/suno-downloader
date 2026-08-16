"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(__dirname, "..", "suno-console-download.js");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8")
  .replace("const PAUSE_MS = 1500", "const PAUSE_MS = 0");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const MP3_BYTES = (() => {
  // Two MPEG-1 Layer III, 128 kbps, 44.1 kHz frame headers at the calculated
  // 417-byte spacing. The payload need not decode for downloader validation.
  const bytes = new Uint8Array(834);
  bytes.set([0xff, 0xfb, 0x90, 0x00], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x00], 417);
  return bytes;
})();
const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, // RIFF, 38 bytes after size
  0x57, 0x41, 0x56, 0x45,                         // WAVE
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, // fmt , PCM chunk size 16
  0x01, 0x00, 0x01, 0x00,                         // PCM, mono
  0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, // 8 kHz sample/byte rate
  0x01, 0x00, 0x08, 0x00,                         // block align 1, 8 bits
  0x64, 0x61, 0x74, 0x61, 0x01, 0x00, 0x00, 0x00, // data, one byte
  0x80, 0x00,                                     // sample plus RIFF padding
]);
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
    if (String(url).endsWith("/api/feed/v3")) return jsonResponse({ clips: options.libraryClips || [], next_cursor: null });
    if (String(url).includes("/api/project/feed")) return jsonResponse({ items: options.workspaceItems || [], next_cursor: null });
    if (String(url).startsWith("https://cdn1.suno.ai/")) return new Response(new Blob([MP3_BYTES]), { status: 200, headers: { "content-type": "audio/mpeg" } });
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
    run() { vm.runInContext(options.script || SCRIPT, context, { filename: SCRIPT_PATH }); },
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

test("re-paste prevents a stale fallback download when response body reading ignores abort", async () => {
  let releaseBlob;
  let bodyReadStarted = false;
  const blobGate = new Promise((resolve) => { releaseBlob = resolve; });
  const runtime = createRuntime({
    usePicker: false,
    libraryClips: [{ id: "stalebody001", title: "Stale body", status: "complete", metadata: {} }],
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url, init });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({
        clips: [{ id: "stalebody001", title: "Stale body", status: "complete", metadata: {} }],
        next_cursor: null,
      });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      if (url.startsWith("https://cdn1.suno.ai/")) return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        blob: async () => {
          bodyReadStarted = true;
          await blobGate;
          return new Blob([MP3_BYTES]);
        },
      };
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => bodyReadStarted, "fallback response body read did not start");
  runtime.run();
  releaseBlob();
  await waitFor(() => runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length === 1,
    "replacement panel did not initialize after the stale response settled");
  assert.deepEqual(runtime.document.downloads, [], "destroyed instance triggered a stale browser download");
});

test("Stop prevents a stale fallback download when response body reading ignores abort", async () => {
  let releaseBlob;
  let bodyReadStarted = false;
  const blobGate = new Promise((resolve) => { releaseBlob = resolve; });
  const runtime = createRuntime({
    usePicker: false,
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url, init });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({
        clips: [{ id: "stoppedbody1", title: "Stopped body", status: "complete", metadata: {} }],
        next_cursor: null,
      });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      if (url.startsWith("https://cdn1.suno.ai/")) return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        blob: async () => {
          bodyReadStarted = true;
          await blobGate;
          return new Blob([MP3_BYTES]);
        },
      };
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => bodyReadStarted, "fallback response body read did not start");
  runtime.document.walk().find((element) => element.textContent === "Stop").click();
  releaseBlob();
  await waitFor(() => /^Stopped\./.test(runtime.status()), "stopped fallback download did not finish");
  assert.deepEqual(runtime.document.downloads, [], "stopped operation triggered a stale browser download");
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

test("re-paste waits for pending directory creation before replacing the instance", async () => {
  let releaseDirectory;
  let directoryRequested = false;
  const directoryGate = new Promise((resolve) => { releaseDirectory = resolve; });
  class HoldingDirectory extends MemoryDirectory {
    async getDirectoryHandle(name, options = {}) {
      directoryRequested = true;
      await directoryGate;
      return super.getDirectoryHandle(name, options);
    }
  }
  const directory = new HoldingDirectory().seed("suno-cache.json", completeCache([
    { id: "dirhandle001", title: "Held directory" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => directoryRequested, "directory creation did not start");
  runtime.run();
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 0,
    "replacement panel initialized while an old directory mutation was pending");
  releaseDirectory();
  await waitFor(() => runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length === 1,
    "replacement panel did not initialize after directory creation settled");
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false,
    "destroyed instance continued from directory creation into a file write");
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
        return new Response(new Blob([WAV_BYTES]), { status: 200, headers: { "content-type": "audio/wav" } });
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

test("an already-pending WAV conversion is polled without another paid POST", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "wavpending001", title: "Pending WAV" },
  ]));
  let wavChecks = 0;
  let convertPosts = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 100 });
      if (url.includes("/api/gen/wavpending001/wav_file/")) {
        wavChecks++;
        return wavChecks === 1
          ? jsonResponse({ state: "processing" })
          : jsonResponse({ wav_file_url: "https://cdn.example/pending-ready.wav" });
      }
      if (url.includes("/api/gen/wavpending001/convert_wav/")) {
        convertPosts++;
        return jsonResponse({});
      }
      if (url === "https://cdn.example/pending-ready.wav")
        return new Response(new Blob([WAV_BYTES]), { status: 200, headers: { "content-type": "audio/wav" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "pending WAV recovery did not finish", 3000);
  assert.equal(convertPosts, 0, "a known pending conversion must not be submitted again");
  assert.equal(wavChecks, 2);
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
});

test("an unknown WAV status shape cannot trigger a paid conversion", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "wavshape0001", title: "Changed WAV API" },
  ]));
  let convertPosts = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 100 });
      if (url.includes("/api/gen/wavshape0001/wav_file/"))
        return jsonResponse({ detail: "new status response" });
      if (url.includes("/api/gen/wavshape0001/convert_wav/")) {
        convertPosts++;
        return jsonResponse({});
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "unexpected WAV shape did not settle", 3000);
  assert.equal(convertPosts, 0, "an unknown read response must fail closed before the paid POST");
  assert.match(runtime.status(), /0 downloaded, 0 skipped, 1 failed/);
});

test("clip IDs are encoded as one URL segment for paid WAV requests", async () => {
  const id = "clip?part/#one";
  const encoded = encodeURIComponent(id);
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id, title: "Encoded path" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url, init });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 100 });
      if (url.endsWith(`/api/gen/${encoded}/wav_file/`)) return jsonResponse({}, 404);
      if (url.endsWith(`/api/gen/${encoded}/convert_wav/`))
        return jsonResponse({ wav_file_url: "https://cdn.example/encoded.wav" });
      if (url === "https://cdn.example/encoded.wav")
        return new Response(new Blob([WAV_BYTES]), { status: 200, headers: { "content-type": "audio/wav" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "encoded WAV path test did not finish", 3000);
  const conversion = runtime.calls.find((call) => call.url.endsWith(`/api/gen/${encoded}/convert_wav/`));
  assert.ok(conversion, "the encoded conversion endpoint was not requested");
  assert.equal(conversion.init.method, "POST");
  assert.equal(runtime.calls.some((call) => call.url.includes("/api/gen/clip?part")), false);
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
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

test("disabled feeds are persisted as complete for cache reuse", async () => {
  const directory = new MemoryDirectory();
  const runtime = createRuntime({
    directory,
    script: SCRIPT.replace("const INCLUDE_LIBRARY = true", "const INCLUDE_LIBRARY = false"),
    workspaceItems: [{
      type: "clip",
      clip: { id: "workspace001", title: "Workspace only", status: "complete", metadata: {} },
    }],
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "disabled-feed download did not finish", 3000);
  assert.equal(runtime.calls.some((call) => call.url.endsWith("/api/feed/v3")), false);
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.libDone, true, "a deliberately disabled feed left the cache permanently partial");
  assert.equal(cache.wsDone, true);
  assert.equal(cache.includeLibrary, false);
  assert.equal(cache.includeWorkspace, true);
});

test("enabling a previously disabled feed forces a clean cache re-scan", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "workspace001", title: "Workspace only" },
  ], { includeLibrary: false, includeWorkspace: true }));
  const runtime = createRuntime({
    directory,
    libraryClips: [{ id: "library00001", title: "Library song", status: "complete", metadata: {} }],
    workspaceItems: [{
      type: "clip",
      clip: { id: "workspace001", title: "Workspace only", status: "complete", metadata: {} },
    }],
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "feed-selection expansion did not finish", 3000);
  assert.equal(runtime.calls.some((call) => call.url.endsWith("/api/feed/v3")), true);
  assert.ok(directory.paths().some((name) => name.endsWith("Library song.mp3")));
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.includeLibrary, true);
  assert.equal(cache.includeWorkspace, true);
  assert.deepEqual(new Set(cache.songs.map((song) => song.id)), new Set(["library00001", "workspace001"]));
});

test("manual re-scan drops cached entries from a feed that is now disabled", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "library00001", title: "Stale library song" },
    { id: "workspace001", title: "Workspace song" },
  ], { includeLibrary: true, includeWorkspace: true }));
  const runtime = createRuntime({
    directory,
    script: SCRIPT.replace("const INCLUDE_LIBRARY = true", "const INCLUDE_LIBRARY = false"),
    workspaceItems: [{
      type: "clip",
      clip: { id: "workspace001", title: "Workspace song", status: "complete", metadata: {} },
    }],
  });
  runtime.run();
  const rescan = runtime.document.walk().find((element) => element.textContent === "Re-scan for new songs");
  rescan.click();
  await waitFor(() => /Re-scan complete/.test(runtime.status()), "feed-selection re-scan did not finish", 3000);
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "post-rescan download did not finish", 3000);
  assert.equal(runtime.calls.some((call) => call.url.endsWith("/api/feed/v3")), false);
  assert.equal(directory.paths().some((name) => name.endsWith("Stale library song.mp3")), false);
  assert.ok(directory.paths().some((name) => name.endsWith("Workspace song.mp3")));
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.deepEqual(cache.songs.map((song) => song.id), ["workspace001"]);
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

test("duplicate song IDs in a cache are rejected instead of silently dropping an entry", async () => {
  const original = completeCache([
    { id: "duplicate001", title: "First entry" },
    { id: "duplicate001", title: "Second entry" },
  ]);
  const directory = new MemoryDirectory().seed("suno-cache.json", original);
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /duplicate song IDs/i.test(runtime.status()), "duplicate cache IDs were not reported");
  assert.equal(runtime.calls.some((call) => /\/api\/(feed\/v3|project\/feed)/.test(call.url)), false);
  assert.equal(runtime.calls.some((call) => /cdn/i.test(call.url)), false);
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

test("re-scan does not early-stop a feed that was incomplete in the cache", async () => {
  const newest = { id: "newest000001", title: "Newest", status: "complete", metadata: {} };
  const older = { id: "older0000001", title: "Older unseen", status: "complete", metadata: {} };
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: newest.id, title: newest.title },
  ], {
    libDone: false,
    libCursor: "interrupted-cursor",
    wsDone: true,
    seenIds: [newest.id],
  }));
  let libraryPages = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) {
        libraryPages++;
        return libraryPages === 1
          ? jsonResponse({ clips: [newest], has_more: true, next_cursor: "older-page" })
          : jsonResponse({ clips: [older], has_more: false, next_cursor: null });
      }
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  const rescan = runtime.document.walk().find((element) => element.textContent === "Re-scan for new songs");
  rescan.click();
  await waitFor(() => /Re-scan complete/.test(runtime.status()), "partial-cache re-scan did not finish", 3000);
  assert.equal(libraryPages, 2, "incomplete feed stopped at a known newest page");
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.libDone, true);
  assert.ok(cache.songs.some((song) => song.id === older.id), "older unseen song was omitted from resumed state");
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

test("a failed cache migration preserves the prior valid resume cache", async () => {
  const original = completeCache([
    { id: "legacystem01", title: "Vocals", isStem: true, parentId: "parent000001", stemName: "Vocals" },
  ], { stemsIncluded: true });
  const directory = new MemoryDirectory().seed("suno-cache.json", original);
  directory.files.get("suno-cache.json").failWrite = true;
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /could not save suno-cache\.json/i.test(runtime.status()),
    "cache migration failure was not shown");
  assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
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

test("Stop during a complete cache read prevents paid confirmation and downloads", async () => {
  let releaseRead;
  let readStarted = false;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "cachedstop001", title: "Cached stop" },
  ]));
  const cacheFile = directory.files.get("suno-cache.json");
  const originalGetFile = cacheFile.getFile.bind(cacheFile);
  cacheFile.getFile = async () => {
    readStarted = true;
    await readGate;
    return originalGetFile();
  };
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => readStarted, "cache read did not start");
  runtime.document.walk().find((element) => element.textContent === "Stop").click();
  releaseRead();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "stopped cache read did not restore the UI");
  assert.equal(runtime.status(), "Stopped before scanning.");
  assert.equal(runtime.confirms.length, 0, "paid confirmation appeared after Stop");
  assert.equal(runtime.calls.some((call) => /\/api\/(?:feed|project|gen)\//.test(call.url)), false);
  assert.equal(runtime.calls.some((call) => /cdn/i.test(call.url)), false);
});

test("Stop during a missing cache probe does not resume an aborted scan", async () => {
  let releaseProbe;
  let probeStarted = false;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  class SlowMissingCacheDirectory extends MemoryDirectory {
    async getFileHandle(name, options = {}) {
      if (name === "suno-cache.json" && !options.create) {
        probeStarted = true;
        await probeGate;
      }
      return super.getFileHandle(name, options);
    }
  }
  const runtime = createRuntime({ directory: new SlowMissingCacheDirectory() });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => probeStarted, "cache probe did not start");
  runtime.document.walk().find((element) => element.textContent === "Stop").click();
  releaseProbe();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "stopped cache probe did not restore the UI");
  assert.equal(runtime.status(), "Stopped before scanning.");
  assert.equal(runtime.calls.some((call) => /\/api\/(?:feed\/v3|project\/feed)/.test(call.url)), false,
    "feed scan started after Stop");
  assert.equal(runtime.calls.some((call) => /cdn/i.test(call.url)), false);
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

test("orphaned clips from one missing parent share one collision-free folder", async () => {
  const songs = [
    { id: "stem-orphan-1", title: "Vocals", isStem: true, parentId: "missing-parent", stemName: "Vocals" },
    { id: "stem-orphan-2", title: "Drums", isStem: true, parentId: "missing-parent", stemName: "Drums" },
    { id: "edit-orphan-1", title: "Replacement", isInfill: true, parentId: "missing-parent" },
  ];
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache(songs, { stemsIncluded: true }));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "orphaned clip download did not finish", 3000);
  const media = directory.paths().filter((name) => name.endsWith(".mp3"));
  assert.equal(media.length, 3, media.join("\n"));
  assert.deepEqual([...new Set(media.map((name) => name.split("/")[0]))],
    ["Missing parent [missing-parent]"]);
  assert.equal(media.filter((name) => name.includes("/stems/")).length, 2);
  assert.equal(media.filter((name) => name.includes("/variations/")).length, 1);
});

test("non-ASCII output components stay within portable filesystem limits", async () => {
  const longTitle = "🎵".repeat(180);
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "unicode00001", title: longTitle },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "Unicode-title download did not finish", 3000);
  for (const pathName of directory.paths().filter((name) => name.endsWith(".mp3"))) {
    for (const component of pathName.split("/")) {
      assert.ok(Buffer.byteLength(component, "utf8") <= 255,
        `component is ${Buffer.byteLength(component, "utf8")} UTF-8 bytes: ${component}`);
      assert.ok(component.length <= 255, `component is ${component.length} UTF-16 code units`);
    }
  }
});

test("Windows superscript device names are escaped before creating output paths", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "reserved0001", title: "COM¹" },
    { id: "reserved0002", title: "LPT²" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "reserved-name download did not finish", 3000);
  const paths = directory.paths();
  assert.ok(paths.some((name) => name.includes("/_COM¹.mp3")));
  assert.ok(paths.some((name) => name.includes("/_LPT².mp3")));
});

test("feed requests use current parameters and paginate from next_cursor without has_more", async () => {
  let libraryPage = 0;
  let workspacePage = 0;
  const runtime = createRuntime({
    fetch: async (url, init = {}) => {
      url = String(url);
      runtime.calls.push({ url, init });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) {
        libraryPage++;
        return jsonResponse({ clips: [], next_cursor: libraryPage === 1 ? "library cursor" : null });
      }
      if (url.includes("/api/project/feed")) {
        workspacePage++;
        return jsonResponse({ items: [], next_cursor: workspacePage === 1 ? "workspace cursor" : null });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "current feed request test did not settle");

  const libraryCalls = runtime.calls.filter((call) => call.url.endsWith("/api/feed/v3"));
  assert.equal(libraryCalls.length, 2);
  assert.deepEqual(JSON.parse(libraryCalls[0].init.body), { cursor: null, limit: 50, filters: {} });
  assert.deepEqual(JSON.parse(libraryCalls[1].init.body), { cursor: "library cursor", limit: 50, filters: {} });

  const workspaceCalls = runtime.calls.filter((call) => call.url.includes("/api/project/feed"));
  assert.equal(workspaceCalls.length, 2);
  const firstQuery = new URL(workspaceCalls[0].url).searchParams;
  assert.equal(firstQuery.get("scope"), "default");
  assert.equal(firstQuery.get("limit"), "50");
  assert.equal(firstQuery.has("n"), false);
  assert.equal(firstQuery.has("cursor"), false);
  const secondQuery = new URL(workspaceCalls[1].url).searchParams;
  assert.equal(secondQuery.get("scope"), "default");
  assert.equal(secondQuery.get("limit"), "50");
  assert.equal(secondQuery.get("cursor"), "workspace cursor");
});

test("a contradictory has_more signal fails closed", async () => {
  const directory = new MemoryDirectory();
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3"))
        return jsonResponse({ clips: [], has_more: false, next_cursor: "contradiction" });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "contradictory feed response did not settle");
  assert.match(runtime.status(), /has_more contradicts next_cursor/i);
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.notEqual(cache.libDone, true);
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

test("a repeated library cursor terminates the scan instead of looping", async () => {
  let feedAttempts = 0;
  const runtime = createRuntime({
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) {
        feedAttempts++;
        return jsonResponse({ clips: [], has_more: true, next_cursor: "stuck" });
      }
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "repeated library cursor did not settle");
  assert.equal(feedAttempts, 2);
  assert.match(runtime.status(), /library feed pagination cursor did not advance/i);
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

test("a repeated workspace cursor terminates the scan instead of looping", async () => {
  let workspaceAttempts = 0;
  const runtime = createRuntime({
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({ clips: [], has_more: false, next_cursor: null });
      if (url.includes("/api/project/feed")) {
        workspaceAttempts++;
        return jsonResponse({ items: [], next_cursor: "stuck" });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled, "repeated workspace cursor did not settle");
  assert.equal(workspaceAttempts, 2);
  assert.match(runtime.status(), /project feed pagination cursor did not advance/i);
});

test("feed-provided audio URLs are preferred over the legacy CDN convention", async () => {
  const preferredUrl = "https://media.example/song.mp3";
  const runtime = createRuntime({
    libraryClips: [{
      id: "mediaurl0001",
      title: "Feed URL",
      status: "complete",
      metadata: {},
      media_urls: { audio_url: preferredUrl },
    }],
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) return jsonResponse({
        clips: [{ id: "mediaurl0001", title: "Feed URL", status: "complete", metadata: {},
          media_urls: { audio_url: preferredUrl } }],
        has_more: false,
        next_cursor: null,
      });
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      if (url === preferredUrl)
        return new Response(new Blob([MP3_BYTES]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "feed audio URL download did not finish", 3000);
  assert.equal(runtime.calls.some((call) => call.url === preferredUrl), true);
  assert.equal(runtime.calls.some((call) => call.url === "https://cdn1.suno.ai/mediaurl0001.mp3"), false);
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
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

test("a non-audio 200 response is rejected instead of being saved as MP3", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "imagebody001", title: "Image body" },
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
        return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "non-audio CDN test did not finish");
  assert.equal(cdnAttempts, 1, "a deterministic invalid body should not be retried");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("a valid MP3 is accepted with a generic CDN content type", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "octetmp30001", title: "Generic MIME" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/"))
        return new Response(new Blob([MP3_BYTES]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "generic-MIME MP3 test did not finish");
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), true);
});

test("an ID3 header without MPEG audio frames is rejected", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "id3only00001", title: "ID3 only" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/"))
        return new Response(new Blob([new Uint8Array([
          0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "ID3-only response test did not finish");
  assert.match(runtime.status(), /MP3: response is not an MP3 file/i);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("a truncated second MPEG frame is rejected instead of being saved as MP3", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "truncated001", title: "Truncated MP3" },
  ]));
  const truncated = new Uint8Array(421);
  truncated.set([0xff, 0xfb, 0x90, 0x00], 0);
  truncated.set([0xff, 0xfb, 0x90, 0x00], 417);
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/"))
        return new Response(new Blob([truncated]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "truncated-frame test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("generic random binary with one embedded MPEG-like sync is rejected as MP3", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "randommp3001", title: "Random binary" },
  ]));
  const randomBinary = new Uint8Array(4096);
  randomBinary.fill(0x5a);
  randomBinary.set([0xff, 0xfb, 0x90, 0x64], 100);
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/"))
        return new Response(new Blob([randomBinary]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "random-binary MP3 test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("WAV downloads require a WAV container even when the MIME type says audio", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "badwavbody01", title: "Bad WAV body" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.includes("/api/gen/badwavbody01/wav_file/"))
        return jsonResponse({ wav_file_url: "https://cdn.example/not-really.wav" });
      if (url === "https://cdn.example/not-really.wav")
        return new Response(new Blob([new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
          0x57, 0x41, 0x56, 0x45,
        ])]), { status: 200, headers: { "content-type": "audio/wav" } });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "invalid WAV container test did not finish");
  assert.match(runtime.status(), /1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".wav")), false);
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
        return new Response(new Blob([MP3_BYTES]), { status: 200, headers: { "content-type": "audio/mpeg" } });
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

test("encoded media does not compare decoded bytes with encoded Content-Length", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "encodedmp3001", title: "Encoded MP3" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/")) {
        return new Response(new Blob([MP3_BYTES]), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(MP3_BYTES.length + 17),
            "content-encoding": "gzip",
          },
        });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "encoded MP3 download did not finish", 3000);
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
  assert.ok(directory.paths().some((name) => name.endsWith(".mp3")));
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

test("MIDI note-offs precede note-ons at the same tick", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "miditicks001", title: "MIDI same tick" },
  ]));
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.includes("/api/gen/miditicks001/midi/")) return jsonResponse({
        state: "complete",
        instruments: [{ name: "Piano", is_drum: false, notes: [
          // Deliberately return the later note first. Its note-on shares a tick
          // with the earlier note's note-off.
          { pitch: 60, start: 1, end: 2, velocity: 0.8 },
          { pitch: 60, start: 0, end: 1, velocity: 0.8 },
        ] }],
      });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-midi").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "MIDI same-tick test did not finish");
  const songDir = directory.directories.values().next().value;
  const midiFile = [...songDir.files.entries()].find(([name]) => name.endsWith(".mid"))[1];
  const bytes = new Uint8Array(await midiFile.blob.arrayBuffer());
  const noteOns = [];
  const noteOffs = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x90 && bytes[i + 1] === 60) noteOns.push(i);
    if (bytes[i] === 0x80 && bytes[i + 1] === 60) noteOffs.push(i);
  }
  assert.equal(noteOns.length, 2);
  assert.equal(noteOffs.length, 2);
  assert.ok(noteOffs[0] < noteOns[1], "same-tick note-on was written before note-off");
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

test("fallback song names cannot collide with synthesized stem names", async () => {
  const runtime = createRuntime({
    usePicker: false,
    libraryClips: [
      { id: "parent000001", title: "Parent", status: "complete", metadata: {} },
      { id: "stem0000001", title: "Vocals", status: "complete",
        metadata: { stem_from_id: "parent000001", stem_type_group_name: "Vocals" } },
      { id: "song00000001", title: "Parent - Vocals [stem0000]", status: "complete", metadata: {} },
    ],
  });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "fallback collision test did not finish", 3000);
  const keys = runtime.document.downloads.map((name) => name.normalize("NFC").toLowerCase());
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, keys.length);
});

test("fallback duplicate stems get one stable clip ID suffix apiece", async () => {
  const runtime = createRuntime({
    usePicker: false,
    libraryClips: [
      { id: "parent000001", title: "Parent", status: "complete", metadata: {} },
      { id: "stem0000001", title: "Vocals", status: "complete",
        metadata: { stem_from_id: "parent000001", stem_type_group_name: "Vocals" } },
      { id: "stem0000002", title: "Vocals", status: "complete",
        metadata: { stem_from_id: "parent000001", stem_type_group_name: "Vocals" } },
    ],
  });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "fallback stem download did not finish", 3000);
  const stems = runtime.document.downloads.filter((name) => name.startsWith("Parent - Vocals"));
  assert.deepEqual(stems.sort(), [
    "Parent - Vocals [stem0000002].mp3",
    "Parent - Vocals [stem0000001].mp3",
  ].sort());
});

test("Include stems downloads existing stem MP3s even when the song format is WAV", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "existingstem1", title: "Vocals", isStem: true, parentId: "missingparent", stemName: "Vocals" },
  ], { stemsIncluded: true }));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = true;
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "existing stem download did not finish", 3000);
  assert.ok(directory.paths().some((name) => name.endsWith("/stems/Vocals.mp3")));
  assert.equal(runtime.calls.some((call) => /\/api\/gen\//.test(call.url)), false,
    "downloading an existing stem invoked a conversion endpoint");
  assert.match(runtime.status(), /1 downloaded, 0 skipped, 0 failed/);
});

test("case-insensitive ID suffix collisions cannot merge song folders", async () => {
  class CaseInsensitiveDirectory extends MemoryDirectory {
    async getDirectoryHandle(name, options = {}) {
      const existingName = [...this.directories.keys()].find((key) => key.toLowerCase() === name.toLowerCase());
      if (existingName) return this.directories.get(existingName);
      if (!options.create) return super.getDirectoryHandle(name, options);
      const directory = new CaseInsensitiveDirectory(name);
      this.directories.set(name, directory);
      return directory;
    }

    async getFileHandle(name, options = {}) {
      const existingName = [...this.files.keys()].find((key) => key.toLowerCase() === name.toLowerCase());
      return super.getFileHandle(existingName || name, options);
    }
  }
  const directory = new CaseInsensitiveDirectory().seed("suno-cache.json", completeCache([
    { id: "ABCDEF001111", title: "Same title" },
    { id: "abcdef001111", title: "Same title" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "case-insensitive collision test did not finish", 3000);
  const media = directory.paths().filter((name) => name.endsWith(".mp3"));
  assert.equal(media.length, 2, media.join("\n"));
  assert.equal(new Set(media.map((name) => name.toLowerCase())).size, 2);
});

test("a later duplicate stem does not rename or redownload the original stem", async () => {
  const parent = { id: "parent000001", title: "Parent" };
  const oldStem = {
    id: "oldstem00001", title: "Vocals", isStem: true,
    parentId: parent.id, stemName: "Vocals",
  };
  const directory = new MemoryDirectory().seed("suno-cache.json",
    completeCache([parent, oldStem], { stemsIncluded: true }));
  const runtime = createRuntime({
    directory,
    libraryClips: [
      { ...parent, status: "complete", metadata: {} },
      { id: oldStem.id, title: "Vocals", status: "complete",
        metadata: { stem_from_id: parent.id, stem_type_group_name: "Vocals" } },
      { id: "newstem00001", title: "Vocals", status: "complete",
        metadata: { stem_from_id: parent.id, stem_type_group_name: "Vocals" } },
    ],
  });
  runtime.run();
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "first stem run did not finish", 3000);
  const rescan = runtime.document.walk().find((element) => element.textContent === "Re-scan for new songs");
  rescan.click();
  await waitFor(() => /Re-scan complete/.test(runtime.status()), "duplicate stem re-scan did not finish", 3000);
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "second stem run did not finish", 3000);
  const stems = directory.paths().filter((name) => name.includes("/stems/") && name.endsWith(".mp3"));
  assert.equal(stems.length, 2, stems.join("\n"));
  assert.ok(stems.some((name) => name.endsWith("/stems/Vocals.mp3")), stems.join("\n"));
  assert.ok(stems.some((name) => name.endsWith("/stems/Vocals [newstem0].mp3")), stems.join("\n"));
  assert.equal(stems.some((name) => name.includes("oldstem")), false, "the original stem was renamed");
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.songs.find((song) => song.id === oldStem.id).stemOutputBase, "Vocals");
});

test("a later duplicate variation does not rename or redownload the original variation", async () => {
  const parent = { id: "parent000001", title: "Parent" };
  const title = "[00:10 - 00:20] verse";
  const oldVariation = {
    id: "oldedit00001", title, isInfill: true, parentId: parent.id,
  };
  const infillMetadata = {
    task: "infill",
    history: [{ type: "concat_infilling", id: parent.id }],
  };
  const directory = new MemoryDirectory().seed("suno-cache.json",
    completeCache([parent, oldVariation]));
  const runtime = createRuntime({
    directory,
    libraryClips: [
      { ...parent, status: "complete", metadata: {} },
      { id: oldVariation.id, title, status: "complete", metadata: infillMetadata },
      { id: "newedit00001", title, status: "complete", metadata: infillMetadata },
    ],
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "first variation run did not finish", 3000);
  const rescan = runtime.document.walk().find((element) => element.textContent === "Re-scan for new songs");
  rescan.click();
  await waitFor(() => /Re-scan complete/.test(runtime.status()), "variation re-scan did not finish", 3000);
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "second variation run did not finish", 3000);
  const variations = directory.paths().filter((name) => name.includes("/variations/") && name.endsWith(".mp3"));
  assert.equal(variations.length, 2, variations.join("\n"));
  assert.ok(variations.some((name) => name.endsWith("/variations/[00_10 - 00_20] verse.mp3")), variations.join("\n"));
  assert.ok(variations.some((name) => name.endsWith("/variations/[00_10 - 00_20] verse [newedit0].mp3")),
    variations.join("\n"));
  assert.equal(variations.some((name) => name.includes("oldedit")), false, "the original variation was renamed");
  const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
  assert.equal(cache.songs.find((song) => song.id === oldVariation.id).variationOutputBase,
    "[00_10 - 00_20] verse");
});

test("folder picker is non-cancellable and re-paste waits for it to settle", async () => {
  let resolvePicker;
  const picker = new Promise((resolve) => { resolvePicker = resolve; });
  const runtime = createRuntime({ pick: () => picker });
  runtime.run();
  runtime.element("suno-dl-pick").click();
  const stop = runtime.document.walk().find((element) => element.textContent === "Stop");
  assert.equal(stop.disabled, true, "Stop must not imply that the native picker can be cancelled");
  runtime.run();
  assert.equal(runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length, 0,
    "replacement initialized while the old picker handler was pending");
  resolvePicker(runtime.directory);
  await waitFor(() => runtime.document.querySelectorAll("#suno-bulk-downloader-panel").length === 1,
    "replacement did not initialize after the picker settled");
});

test("folder picker permission errors are not reported as cancellation", async () => {
  const denied = Object.assign(new Error("mock permission denied"), { name: "NotAllowedError" });
  const runtime = createRuntime({ pick: async () => { throw denied; } });
  runtime.run();
  runtime.element("suno-dl-pick").click();
  await waitFor(() => /Folder picker failed/.test(runtime.status()), "picker failure was not reported");
  assert.match(runtime.status(), /permission denied/);
  assert.doesNotMatch(runtime.status(), /cancelled/i);
});

test("background credit retries do not overwrite operation status", async () => {
  let creditsCalls = 0;
  const runtime = createRuntime({
    timerDelay: 1,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) {
        creditsCalls++;
        if (creditsCalls === 1) return jsonResponse({ detail: "temporary" }, 500);
        return jsonResponse({ total_credits_left: 7 });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  await waitFor(() => /Credits left: 7/.test(runtime.element("suno-dl-credits").textContent),
    "credit retry did not settle");
  assert.equal(runtime.status(), "", "background credit retry clobbered the main status");
});

test("Include stems can run without selecting a full-song format", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "stemonly0001", title: "Vocals", isStem: true, parentId: "missingparent", stemName: "Vocals" },
  ], { stemsIncluded: true }));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-mp3").checked = false;
  runtime.element("suno-dl-wav").checked = false;
  runtime.element("suno-dl-midi").checked = false;
  runtime.element("suno-dl-stems").checked = true;
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "stems-only operation did not finish", 3000);
  assert.ok(directory.paths().some((name) => name.endsWith("/stems/Vocals.mp3")));
  assert.equal(runtime.confirms.length, 0, "free existing stems prompted for paid conversion approval");
  assert.equal(runtime.calls.some((call) => /\/api\/gen\//.test(call.url)), false,
    "stems-only operation invoked a conversion endpoint");
});

test("a permanently hung API response body times out and restores the UI", async () => {
  let feedAttempts = 0;
  const runtime = createRuntime({
    fireLongTimers: true,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.endsWith("/api/feed/v3")) {
        feedAttempts++;
        return {
          status: 200,
          text: async () => new Promise(() => {}),
        };
      }
      if (url.includes("/api/project/feed")) return jsonResponse({ items: [], next_cursor: null });
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => !runtime.element("suno-dl-btn").disabled,
    "hung API response body did not time out and restore the UI", 5000);
  assert.equal(feedAttempts, 6, "hung API body retries were not bounded");
  assert.match(runtime.status(), /^Error: library feed error 0: response timed out after retries/);
});

test("a permanently hung media response body times out and restores the UI", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "hungmedia001", title: "Hung media" },
  ]));
  let mediaAttempts = 0;
  const runtime = createRuntime({
    directory,
    fireLongTimers: true,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/")) {
        mediaAttempts++;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "audio/mpeg" }),
          blob: async () => new Promise(() => {}),
        };
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()),
    "hung media response body did not time out and restore the UI", 5000);
  assert.equal(mediaAttempts, 3, "hung media body retries were not bounded");
  assert.match(runtime.status(), /0 downloaded, 0 skipped, 1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

test("Stop before a folder write commits aborts the pending media file", async () => {
  let releaseWrite;
  let writeStarted = false;
  let closeCalls = 0;
  let abortCalls = 0;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
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
      if (!name.endsWith(".mp3")) return super.getFileHandle(name, options);
      let file = this.files.get(name);
      if (!file && options.create) {
        file = new MemoryFile();
        this.files.set(name, file);
      }
      if (!file) return super.getFileHandle(name, options);
      file.createWritable = async () => {
        let pending = file.blob;
        return {
          write: async (content) => {
            pending = content instanceof Blob ? content : new Blob([content]);
            writeStarted = true;
            await writeGate;
          },
          close: async () => { closeCalls++; file.blob = pending; },
          abort: async () => { abortCalls++; },
        };
      };
      return file;
    }
  }
  const directory = new HoldingDirectory().seed("suno-cache.json", completeCache([
    { id: "stopwrite001", title: "Stop write" },
  ]));
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => writeStarted, "folder media write did not start");
  runtime.document.walk().find((element) => element.textContent === "Stop").click();
  releaseWrite();
  await waitFor(() => /^Stopped\./.test(runtime.status()), "stopped folder write did not settle");
  assert.equal(closeCalls, 0, "stopped media write was committed");
  assert.equal(abortCalls, 1, "stopped media write was not aborted");
  const mediaPath = directory.paths().find((name) => name.endsWith(".mp3"));
  assert.ok(mediaPath, "mock file handle was not created before cancellation");
  const songDir = directory.directories.values().next().value;
  const mediaFile = [...songDir.files.values()].find((file) => file instanceof MemoryFile);
  assert.equal(mediaFile.blob.size, 0, "stopped media bytes were committed to the folder");
});

test("an unsolicited partial MP3 response is rejected", async () => {
  const directory = new MemoryDirectory().seed("suno-cache.json", completeCache([
    { id: "partialmp3001", title: "Partial MP3" },
  ]));
  let mediaAttempts = 0;
  const runtime = createRuntime({
    directory,
    fetch: async (url) => {
      url = String(url);
      runtime.calls.push({ url });
      if (url.endsWith("/api/billing/credits")) return jsonResponse({ total_credits_left: 1 });
      if (url.startsWith("https://cdn1.suno.ai/")) {
        mediaAttempts++;
        return new Response(new Blob([MP3_BYTES]), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-833/1668" },
        });
      }
      throw new Error("Unexpected fetch: " + url);
    },
  });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /^Done\./.test(runtime.status()), "partial MP3 response test did not finish");
  assert.equal(mediaAttempts, 1, "deterministic unsolicited partial response was retried");
  assert.match(runtime.status(), /0 downloaded, 0 skipped, 1 failed/);
  assert.equal(directory.paths().some((name) => name.endsWith(".mp3")), false);
});

for (const [name, clips, workspaceItems] of [
  ["empty library", [{ id: "", title: "Bad", status: "complete", metadata: {} }], []],
  ["whitespace library", [{ id: "   ", title: "Bad", status: "complete", metadata: {} }], []],
  ["empty workspace", [], [{ type: "clip", clip: { id: "", title: "Bad", status: "complete", metadata: {} } }]],
  ["whitespace workspace", [], [{ type: "clip", clip: { id: "\t", title: "Bad", status: "complete", metadata: {} } }]],
]) {
  test(name + " clip IDs are rejected before caching or downloading", async () => {
    const directory = new MemoryDirectory();
    const runtime = createRuntime({ directory, libraryClips: clips, workspaceItems });
    runtime.run();
    runtime.element("suno-dl-btn").click();
    await waitFor(() => !runtime.element("suno-dl-btn").disabled, name + " ID test did not settle");
    assert.match(runtime.status(), /invalid clip entry/i);
    assert.equal(runtime.calls.some((call) => call.url.startsWith("https://cdn1.suno.ai/")), false);
    const cache = JSON.parse(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()));
    assert.equal(cache.songs.some((song) => !song.id.trim()), false);
  });
}

for (const badId of ["", "   "]) {
  test("a cache with " + (badId ? "a whitespace-only" : "an empty") + " song ID is rejected unchanged", async () => {
    const original = completeCache([{ id: badId, title: "Bad cache ID" }]);
    const directory = new MemoryDirectory().seed("suno-cache.json", original);
    const runtime = createRuntime({ directory });
    runtime.run();
    runtime.element("suno-dl-btn").click();
    await waitFor(() => /invalid song entry/i.test(runtime.status()), "invalid cached ID was not reported");
    assert.equal(runtime.calls.some((call) => /cdn|\/api\/(feed\/v3|project\/feed)/i.test(call.url)), false);
    assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
  });
}

test("a cache with a whitespace-only seen ID is rejected unchanged", async () => {
  const original = completeCache([], { seenIds: ["   "] });
  const directory = new MemoryDirectory().seed("suno-cache.json", original);
  const runtime = createRuntime({ directory });
  runtime.run();
  runtime.element("suno-dl-btn").click();
  await waitFor(() => /invalid seen ID/i.test(runtime.status()), "invalid cached seen ID was not reported");
  assert.equal(runtime.calls.some((call) => /cdn|\/api\/(feed\/v3|project\/feed)/i.test(call.url)), false);
  assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
});

for (const [field, value] of [
  ["libCursor", []],
  ["wsCursor", 42],
  ["scanned", "12"],
]) {
  test("a cache with an invalid " + field + " type is rejected unchanged", async () => {
    const original = completeCache([], { [field]: value, libDone: false, wsDone: false });
    const directory = new MemoryDirectory().seed("suno-cache.json", original);
    const runtime = createRuntime({ directory });
    runtime.run();
    runtime.element("suno-dl-btn").click();
    await waitFor(() => /cache/i.test(runtime.status()) && new RegExp(field, "i").test(runtime.status()),
      "invalid " + field + " was not reported");
    assert.equal(runtime.calls.some((call) => /\/api\/(feed\/v3|project\/feed)/.test(call.url)), false);
    assert.equal(await (await directory.getFileHandle("suno-cache.json")).getFile().then((file) => file.text()), original);
  });
}

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
