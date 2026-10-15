/**
 * Build a single-file Studio executable (Node SEA) + resources folder.
 *   node studio/build.mjs            -> dist/studio/<shorts-studio[.exe]> + dist/studio/resources/{worker,bin}
 * Windows CI then wraps dist/studio with Inno Setup into ShortsAutopilotStudio-Setup.exe.
 * Optional env: BUNDLE_UV=1 (download uv), BUNDLE_FFMPEG=1 (copy ffmpeg-static binary for this platform).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "studio");
const win = process.platform === "win32";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "resources", "bin"), { recursive: true });

// 1. SEA blob (main + embedded UI)
const cfg = path.join(out, "sea-config.json");
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(root, "studio", "main.cjs"), output: path.join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, assets: { "ui.html": path.join(root, "studio", "ui.html") } }));
execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "inherit" });

// 2. copy node binary and inject the blob
const exe = path.join(out, win ? "ShortsStudio.exe" : "shorts-studio");
fs.copyFileSync(process.execPath, exe);
if (win) {
  try { execFileSync("signtool", ["remove", "/s", exe], { stdio: "ignore" }); } catch { /* unsigned node or no signtool */ }
}
execFileSync(win ? "npx.cmd" : "npx", ["--yes", "postject@1.0.0-alpha.6", exe, "NODE_SEA_BLOB", path.join(out, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit", shell: win });
fs.rmSync(path.join(out, "sea-prep.blob"));
fs.rmSync(cfg);

// 3. resources: worker runtime + plugins (+ optional uv / ffmpeg)
fs.cpSync(path.join(root, "worker"), path.join(out, "resources", "worker"), { recursive: true, filter: (s) => !s.includes("__pycache__") });
if (process.env.BUNDLE_FFMPEG) {
  const ff = path.join(root, "node_modules", "ffmpeg-static", win ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(ff)) fs.copyFileSync(ff, path.join(out, "resources", "bin", path.basename(ff)));
}

// 4. "Run everything on this PC": the whole web app as a self-contained server + a plain node runtime
//    (the SEA exe always runs its embedded script, so the app server needs its own node binary).
if (process.env.BUNDLE_APP) {
  execFileSync(win ? "npx.cmd" : "npx", ["next", "build"], { cwd: root, stdio: "inherit", shell: win, env: { ...process.env, NEXT_STANDALONE: "1" } });
  const app = path.join(out, "resources", "app");
  fs.cpSync(path.join(root, ".next", "standalone"), app, { recursive: true });
  // Belt and braces: personal data and build output must never ship inside the installer.
  for (const d of [".data", "dist", "docs", "worker", "studio", "tests", "src", ".env", ".env.local"]) fs.rmSync(path.join(app, d), { recursive: true, force: true });
  fs.cpSync(path.join(root, ".next", "static"), path.join(app, ".next", "static"), { recursive: true });
  if (fs.existsSync(path.join(root, "public"))) fs.cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
  fs.cpSync(path.join(root, "assets"), path.join(app, "assets"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(out, "resources", "bin", win ? "node.exe" : "node"));
  console.log("bundled app server", app);
}
console.log("built", exe);
