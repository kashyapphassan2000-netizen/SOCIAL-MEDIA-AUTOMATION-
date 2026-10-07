#!/usr/bin/env node
/**
 * Shorts Autopilot Studio — local control panel for the free AI worker.
 *
 *  - Plugin manager: install / test / remove open-source models, set the preferred order per kind.
 *  - "Paste a GitHub link": a free LLM drafts plugin.json + adapter.py from the repo README; you review, install, test.
 *  - A/B compare: run every installed plugin of a kind on YOUR photo / voice / clip and pick the best.
 *  - Local worker: renders your app's queued voice / lip-sync / avatar tasks on this PC's GPU.
 *
 * Zero npm dependencies so it can be packed into one executable (Node SEA). Runs on Windows, macOS, Linux.
 * On Windows, GPU plugins that need Linux-only packages can run inside WSL2 ("Run in WSL" setting).
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const IS_WIN = process.platform === "win32";
const PORT = Number(process.env.STUDIO_PORT || 7788);
const DATA = process.env.STUDIO_HOME || path.join(IS_WIN ? process.env.APPDATA || os.homedir() : os.homedir(), IS_WIN ? "ShortsStudio" : ".shorts-studio");
fs.mkdirSync(path.join(DATA, "inputs"), { recursive: true });

// ------------------------------------------------------------------ resources (bundled worker, uv, ffmpeg)
function findResources() {
  const cands = [
    process.env.STUDIO_RESOURCES,
    path.join(path.dirname(process.execPath), "resources"),
    path.join(__dirname, "resources"),
    path.join(__dirname, ".."), // dev: repo root (worker/ lives next to studio/)
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, "worker", "plugin_cli.py"))) return c;
  throw new Error("worker files not found — reinstall Studio");
}
const RES = findResources();
const WORKER_DIR = path.join(RES, "worker");
const BIN = path.join(RES, "bin");

// ------------------------------------------------------------------ config
const CFG_FILE = path.join(DATA, "config.json");
const defaults = { appUrl: "", workerSecret: "", geminiKey: "", groqKey: "", workerHome: path.join(DATA, "worker-home"), useWsl: false, kinds: "tts,lipsync,avatar", autoStartWorker: false };
function loadCfg() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) };
  } catch {
    return { ...defaults };
  }
}
function saveCfg(c) {
  fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
}
let cfg = loadCfg();

// ------------------------------------------------------------------ python via uv (installs Python itself if missing)
function which(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
function uvPath() {
  const bundled = path.join(BIN, IS_WIN ? "uv.exe" : "uv");
  return fs.existsSync(bundled) ? bundled : which("uv");
}
let pythonCache = null;
function python() {
  if (pythonCache) return pythonCache;
  const uv = uvPath();
  if (uv) {
    let r = spawnSync(uv, ["python", "find", "3.11"], { encoding: "utf8" });
    if (r.status !== 0) {
      spawnSync(uv, ["python", "install", "3.11"], { stdio: "inherit" });
      r = spawnSync(uv, ["python", "find", "3.11"], { encoding: "utf8" });
    }
    if (r.status === 0) return (pythonCache = r.stdout.trim());
  }
  pythonCache = which("python3.11") || which("python3") || which("python") || "python";
  return pythonCache;
}
function childEnv(extra = {}) {
  const sep = IS_WIN ? ";" : ":";
  return {
    ...process.env,
    PATH: `${BIN}${sep}${path.dirname(uvPath() || "")}${sep}${process.env.PATH}`,
    WORKER_HOME: cfg.workerHome,
    APP_URL: cfg.appUrl,
    WORKER_SECRET: cfg.workerSecret,
    GEMINI_API_KEY: cfg.geminiKey || process.env.GEMINI_API_KEY || "",
    GROQ_API_KEY: cfg.groqKey || process.env.GROQ_API_KEY || "",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    ...extra,
  };
}

/** Windows path -> WSL path (C:\x\y -> /mnt/c/x/y). */
function toWsl(p) {
  return p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}
/** Build the command for a worker script, natively or inside WSL2. */
function pyCommand(script, args, env = {}) {
  if (IS_WIN && cfg.useWsl) {
    const e = { WORKER_HOME: "$HOME/.shorts-worker", APP_URL: cfg.appUrl, WORKER_SECRET: cfg.workerSecret, GEMINI_API_KEY: cfg.geminiKey, GROQ_API_KEY: cfg.groqKey, ...env };
    const exports = Object.entries(e).map(([k, v]) => `${k}=${JSON.stringify(String(v ?? ""))}`).join(" ");
    const line = `cd ${JSON.stringify(toWsl(WORKER_DIR))} && ${exports} python3 ${script} ${args.map((a) => JSON.stringify(toWsl(String(a)))).join(" ")}`;
    return { cmd: "wsl.exe", args: ["-e", "bash", "-lc", line], env: process.env };
  }
  return { cmd: python(), args: [path.join(WORKER_DIR, script), ...args], env: childEnv(env) };
}

// ------------------------------------------------------------------ jobs with live logs (SSE)
const jobs = new Map(); // id -> {id, title, lines[], done, code, result, listeners:Set}
function startJob(title, script, args, env = {}) {
  const id = crypto.randomBytes(6).toString("hex");
  const job = { id, title, lines: [], done: false, code: null, result: null, listeners: new Set(), started: Date.now() };
  jobs.set(id, job);
  const { cmd, args: a, env: e } = pyCommand(script, args, env);
  const p = spawn(cmd, a, { env: e, cwd: WORKER_DIR });
  job.proc = p;
  const push = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.lines.push(line);
      if (job.lines.length > 3000) job.lines.shift();
      if (line.startsWith("{")) {
        try {
          job.result = JSON.parse(line);
        } catch {
          /* not json */
        }
      }
      for (const l of job.listeners) l(`data: ${JSON.stringify({ line })}\n\n`);
    }
  };
  p.stdout.on("data", push);
  p.stderr.on("data", push);
  p.on("error", (err) => push(`ERROR: ${err.message}`));
  p.on("close", (code) => {
    job.done = true;
    job.code = code;
    for (const l of job.listeners) l(`event: done\ndata: ${JSON.stringify({ code, result: job.result })}\n\n`);
  });
  return job;
}
function runSync(script, args) {
  const { cmd, args: a, env } = pyCommand(script, args);
  const r = spawnSync(cmd, a, { env, cwd: WORKER_DIR, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "failed").slice(-2000));
  return r.stdout;
}

let worker = null; // the long-running free_worker.py job
function startWorker() {
  if (worker && !worker.done) return worker;
  if (!cfg.appUrl || !cfg.workerSecret) throw new Error("Set your App URL and Worker secret first");
  worker = startJob("Local worker", "free_worker.py", [], { IDLE_EXIT_SEC: "0", WORKER_KINDS: cfg.kinds, WORKER_NAME: `studio-${os.hostname()}` });
  return worker;
}

// ------------------------------------------------------------------ http
function ui() {
  try {
    return require("node:sea").getAsset("ui.html", "utf8");
  } catch {
    return fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");
  }
}
const TOKEN = crypto.randomBytes(16).toString("hex"); // blocks other local sites from driving the API
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const json = async (req) => JSON.parse((await readBody(req)).toString() || "{}");
const ALLOWED_FILE_ROOTS = () => [DATA, os.tmpdir(), cfg.workerHome, path.join(WORKER_DIR, "samples")].map((p) => path.resolve(p));

async function route(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === "/") return send(res, 200, ui().replace("__TOKEN__", TOKEN), "text/html; charset=utf-8");
  if (u.pathname.startsWith("/api/") && req.headers["x-studio-token"] !== TOKEN && u.searchParams.get("t") !== TOKEN) return send(res, 403, { error: "bad token" });

  if (u.pathname === "/api/status") {
    let gpu = null;
    const smi = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8" });
    if (smi.status === 0) gpu = smi.stdout.trim();
    return send(res, 200, {
      cfg: { ...cfg, workerSecret: cfg.workerSecret ? "••••" : "", geminiKey: cfg.geminiKey ? "••••" : "", groqKey: cfg.groqKey ? "••••" : "" },
      gpu, python: python(), uv: uvPath(), ffmpeg: fs.existsSync(path.join(BIN, IS_WIN ? "ffmpeg.exe" : "ffmpeg")) || !!which("ffmpeg"), git: !!which("git"),
      wsl: IS_WIN ? spawnSync("wsl.exe", ["--status"]).status === 0 : null, platform: process.platform, resources: RES, data: DATA,
      worker: worker ? { id: worker.id, running: !worker.done } : null,
    });
  }
  if (u.pathname === "/api/config" && req.method === "POST") {
    const b = await json(req);
    for (const k of Object.keys(defaults)) if (k in b && b[k] !== "••••") cfg[k] = b[k];
    saveCfg(cfg);
    return send(res, 200, { ok: true });
  }
  if (u.pathname === "/api/plugins") {
    try {
      return send(res, 200, JSON.parse(runSync("plugin_cli.py", ["list", "--json"])));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  if (u.pathname === "/api/run" && req.method === "POST") {
    // {action: install|uninstall|test|compare|order|draft, id?, kind?, ids?, url?}
    const b = await json(req);
    const inputs = [];
    for (const k of ["image", "video", "ref", "audio"]) if (b[k]) inputs.push(`--${k}`, b[k]);
    if (b.text) inputs.push("--text", b.text);
    if (b.lang) inputs.push("--lang", b.lang);
    const map = {
      install: () => ["install", b.id, ...(b.force ? ["--force"] : [])],
      uninstall: () => ["uninstall", b.id],
      test: () => ["test", b.id, ...inputs, "--out-dir", path.join(DATA, "outputs", `${b.id}-${Date.now()}`)],
      compare: () => ["compare", b.kind, ...inputs, "--out-dir", path.join(DATA, "outputs", `cmp-${b.kind}-${Date.now()}`)],
      order: () => ["order", b.kind, ...(b.ids || [])],
      draft: () => ["draft", b.url, "--kind", b.kind || "tts", "--save"],
    };
    if (!map[b.action]) return send(res, 400, { error: "unknown action" });
    const job = startJob(`${b.action} ${b.id || b.kind || b.url || ""}`, "plugin_cli.py", map[b.action]());
    return send(res, 200, { job: job.id });
  }
  if (u.pathname === "/api/plugin-source") {
    // view / edit a user plugin's files (review what the LLM drafted)
    const id = String(u.searchParams.get("id") || "").replace(/[^\w-]/g, "");
    const dir = path.join(cfg.workerHome, "plugins", id);
    if (req.method === "POST") {
      const b = await json(req);
      if (!fs.existsSync(dir)) return send(res, 404, { error: "only user plugins are editable" });
      JSON.parse(b.manifest);
      fs.writeFileSync(path.join(dir, "plugin.json"), b.manifest);
      fs.writeFileSync(path.join(dir, "adapter.py"), b.adapter);
      if (b.setup) fs.writeFileSync(path.join(dir, "setup.py"), b.setup);
      return send(res, 200, { ok: true });
    }
    const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
    return send(res, 200, { editable: fs.existsSync(dir), manifest: read("plugin.json"), adapter: read("adapter.py"), setup: read("setup.py") });
  }
  if (u.pathname === "/api/upload" && req.method === "POST") {
    const kind = String(u.searchParams.get("kind") || "file").replace(/\W/g, "");
    const ext = String(u.searchParams.get("ext") || "bin").replace(/\W/g, "").slice(0, 5);
    const file = path.join(DATA, "inputs", `${kind}.${ext}`);
    fs.writeFileSync(file, await readBody(req));
    return send(res, 200, { path: file });
  }
  if (u.pathname === "/api/worker" && req.method === "POST") {
    const b = await json(req);
    try {
      if (b.action === "start") return send(res, 200, { job: startWorker().id });
      if (b.action === "stop" && worker && !worker.done) worker.proc.kill();
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (u.pathname === "/api/jobs") return send(res, 200, [...jobs.values()].map((j) => ({ id: j.id, title: j.title, done: j.done, code: j.code, result: j.result, started: j.started })).reverse());
  const m = u.pathname.match(/^\/api\/jobs\/(\w+)\/stream$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: "no such job" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    if (job.done) res.write(`event: done\ndata: ${JSON.stringify({ code: job.code, result: job.result })}\n\n`);
    const l = (s) => res.write(s);
    job.listeners.add(l);
    req.on("close", () => job.listeners.delete(l));
    return;
  }
  if (u.pathname === "/api/file") {
    const p = path.resolve(String(u.searchParams.get("path") || ""));
    if (!ALLOWED_FILE_ROOTS().some((r) => p.startsWith(r)) || !fs.existsSync(p)) return send(res, 404, { error: "not found" });
    const type = p.endsWith(".mp4") ? "video/mp4" : p.endsWith(".wav") ? "audio/wav" : p.endsWith(".mp3") ? "audio/mpeg" : p.endsWith(".json") ? "application/json" : "application/octet-stream";
    return send(res, 200, fs.readFileSync(p), type);
  }
  send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => route(req, res).catch((e) => send(res, 500, { error: String(e && e.message ? e.message : e) })));
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Shorts Autopilot Studio running at ${url}`);
  console.log(`resources: ${RES}\ndata: ${DATA}`);
  if (cfg.autoStartWorker) {
    try {
      startWorker();
    } catch (e) {
      console.log("worker not started:", e.message);
    }
  }
  if (!process.env.STUDIO_NO_BROWSER) {
    const opener = IS_WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }
});
