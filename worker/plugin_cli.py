#!/usr/bin/env python3
"""
Manage free-worker model plugins.

  python plugin_cli.py list [--json]
  python plugin_cli.py install <id> [<id>...] [--force]
  python plugin_cli.py uninstall <id>
  python plugin_cli.py order <kind> <id> [<id>...]          set preferred order (first = default)
  python plugin_cli.py test <id> [--image P] [--video P] [--ref P] [--text "..."] [--lang en]
  python plugin_cli.py compare <kind> [--image ...]         run every installed plugin of a kind on the same input
  python plugin_cli.py add <dir-with-plugin.json-and-adapter.py>
  python plugin_cli.py draft <github-url> [--kind tts|lipsync|avatar] [--save]
        Reads the repo README and asks a free LLM to write plugin.json + adapter.py for it.
        Uses APP_URL+WORKER_SECRET (your app's free LLM chain) or GEMINI_API_KEY/GROQ_API_KEY directly.
        ALWAYS review and `test` a drafted plugin before relying on it.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plugin_runtime as rt  # noqa: E402

SAMPLES = os.path.join(rt.HERE, "samples")


def cmd_list(a):
    plugins = rt.load_all()
    rows = []
    for pid, m in sorted(plugins.items(), key=lambda x: (x[1]["kind"], x[0])):
        rows.append({
            "id": pid, "name": m.get("name"), "kind": m["kind"], "license": m.get("license"), "gpu": m.get("gpu", "none"),
            "min_vram_gb": m.get("min_vram_gb"), "installed": rt.is_installed(m), "builtin": m["_builtin"],
            "status": m.get("status", "verified" if m.get("id") in ("chatterbox", "voxcpm2", "faster-whisper", "sadtalker") else ""),
            "homepage": m.get("homepage"), "notes": m.get("notes", ""),
        })
    order = {k: rt.order_for(k) for k in rt.KINDS}
    if a.json:
        print(json.dumps({"plugins": rows, "order": order, "gpu": rt.has_gpu(), "home": rt.HOME}))
        return
    print(f"GPU: {'yes' if rt.has_gpu() else 'no'}   home: {rt.HOME}")
    for r in rows:
        print(f"[{'x' if r['installed'] else ' '}] {r['kind']:8} {r['id']:20} {r['license'] or '?':12} gpu={r['gpu']:8} {r['status']}")
    for k, v in order.items():
        print(f"order {k}: {' > '.join(v)}")


def sample_inputs(a, kind, work):
    ref = a.ref or os.path.join(SAMPLES, "voice_ref.wav")
    image = a.image or os.path.join(SAMPLES, "portrait.png")
    text = a.text or "This is a quick quality test of the voice and lip sync. If it sounds natural, keep it."
    tf = os.path.join(work, "text.txt")
    open(tf, "w", encoding="utf-8").write(text)
    audio = a.audio or os.path.join(SAMPLES, "voice_ref.wav")
    if kind == "tts":
        return {"text_file": tf, "ref": ref, "lang": a.lang, "out": os.path.join(work, "out.wav")}
    if kind == "align":
        return {"audio": audio, "text_file": tf, "lang": a.lang, "out": os.path.join(work, "out.json")}
    if kind == "avatar":
        return {"image": image, "audio": audio, "out": os.path.join(work, "out.mp4")}
    video = a.video
    if not video:  # make a still "clip" from the sample portrait
        video = os.path.join(work, "clip.mp4")
        rt.sh(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", image, "-t", "4", "-vf", "scale=512:-2,fps=25", "-pix_fmt", "yuv420p", video])
    return {"video": video, "audio": audio, "out": os.path.join(work, "out.mp4")}


def cmd_test(a):
    m = rt.get(a.id)
    rt.install(a.id)
    work = a.out_dir or tempfile.mkdtemp(prefix=f"test-{a.id}-")
    os.makedirs(work, exist_ok=True)
    args = sample_inputs(a, m["kind"], work)
    t0 = time.time()
    secs = rt.run(a.id, args)
    out = args["out"]
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    res = {"id": a.id, "ok": ok, "seconds": round(secs, 1), "output": out, "total_seconds": round(time.time() - t0, 1)}
    print(json.dumps(res))
    return res


def cmd_compare(a):
    results = []
    for pid in rt.order_for(a.kind):
        if not rt.is_installed(rt.get(pid)):
            continue
        sub = argparse.Namespace(**{**vars(a), "id": pid, "out_dir": os.path.join(a.out_dir or tempfile.mkdtemp(prefix="cmp-"), pid)})
        try:
            results.append(cmd_test(sub))
        except Exception as e:
            results.append({"id": pid, "ok": False, "error": str(e)[:300]})
    print(json.dumps({"kind": a.kind, "results": results}))


# ---------------------------------------------------------------- drafting a plugin from a GitHub link
CONTRACTS = {
    "tts": "adapter.py --text-file T --ref R --lang L --out OUT.wav   (clone the voice in R, speak the UTF-8 text in T, write a WAV)",
    "lipsync": "adapter.py --video V --audio A --out OUT.mp4   (re-lip-sync the person in V to audio A; V may be shorter than A — loop it)",
    "avatar": "adapter.py --image I --audio A --out OUT.mp4   (animate the person in photo I speaking audio A)",
    "align": "adapter.py --audio A --text-file T --lang L --out OUT.json   (word timestamps [{word,start,end}])",
}

DRAFT_PROMPT = """You are packaging an open-source GitHub model as a plugin for an automated video pipeline.
Repository: {url}
Plugin kind: {kind}
Adapter CLI contract: {contract}

Rules:
- The repo is cloned to the directory in env PLUGIN_REPO; persistent weights go in env PLUGIN_DATA; run commands with cwd=PLUGIN_REPO when the repo expects it.
- Python deps are installed by the runtime from "requirements" (+ "repo_requirements": path to the repo's requirements file); torch is installed from "torch" pins.
- setup.py (optional) runs once inside the venv: download weights (prefer huggingface_hub), patch code. Must be idempotent.
- adapter.py must use only argparse + the repo's own inference code/CLI (subprocess with sys.executable), ffmpeg is on PATH.
- Never invent HF repo ids or CLI flags: use ONLY what the README shows. If something is unknown, raise SystemExit with a clear TODO message instead of guessing.

Return ONE JSON object: {{"manifest": {{"id","name","kind","license","homepage","repo","python","torch","requirements","repo_requirements","gpu","min_vram_gb","timeout_min","status":"drafted by LLM — review and test","notes"}}, "adapter_py": "...", "setup_py": "... or empty"}}

README:
{readme}
"""


def fetch_readme(url):
    parts = url.rstrip("/").replace(".git", "").split("github.com/")[-1].split("/")
    owner, repo = parts[0], parts[1]
    for branch in ("main", "master"):
        for name in ("README.md", "readme.md", "README_EN.md"):
            try:
                with urllib.request.urlopen(f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{name}", timeout=30) as r:
                    return r.read().decode("utf-8", "replace"), f"https://github.com/{owner}/{repo}", repo.lower()
            except Exception:
                continue
    raise SystemExit("could not fetch README (private repo or not on GitHub?)")


def llm(prompt):
    app, secret = os.environ.get("APP_URL"), os.environ.get("WORKER_SECRET")
    if app and secret:
        req = urllib.request.Request(f"{app.rstrip('/')}/api/worker/llm", data=json.dumps({"prompt": prompt}).encode(),
                                     headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())["text"]
    if os.environ.get("GEMINI_API_KEY"):
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json"}}
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{os.environ.get('GEMINI_MODEL', 'gemini-3.6-flash')}:generateContent",
                                     data=json.dumps(body).encode(), headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return "".join(p.get("text", "") for p in json.loads(r.read())["candidates"][0]["content"]["parts"])
    if os.environ.get("GROQ_API_KEY"):
        body = {"model": os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {os.environ['GROQ_API_KEY']}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"]
    raise SystemExit("no LLM available: set APP_URL+WORKER_SECRET, GEMINI_API_KEY or GROQ_API_KEY")


def cmd_draft(a):
    readme, url, name = fetch_readme(a.url)
    text = llm(DRAFT_PROMPT.format(url=url, kind=a.kind, contract=CONTRACTS[a.kind], readme=readme[:30000]))
    start, end = text.find("{"), text.rfind("}")
    d = json.loads(text[start:end + 1])
    man = d["manifest"]
    man.setdefault("id", name)
    man["kind"] = a.kind
    man["repo"] = man.get("repo") or url
    man["status"] = "drafted by LLM — review and test"
    if a.save:
        path = rt.add_user_plugin(man, d["adapter_py"], d.get("setup_py") or None)
        print(json.dumps({"saved": path, "id": man["id"], "manifest": man}))
    else:
        print(json.dumps(d, indent=2))


def cmd_add(a):
    m = json.load(open(os.path.join(a.dir, "plugin.json")))
    setup = os.path.join(a.dir, "setup.py")
    path = rt.add_user_plugin(m, open(os.path.join(a.dir, "adapter.py")).read(), open(setup).read() if os.path.exists(setup) else None)
    print(json.dumps({"saved": path, "id": m["id"]}))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("list"); p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_list)
    p = sp.add_parser("install"); p.add_argument("ids", nargs="+"); p.add_argument("--force", action="store_true")
    p.set_defaults(fn=lambda a: [rt.install(i, a.force) for i in a.ids])
    p = sp.add_parser("uninstall"); p.add_argument("id"); p.set_defaults(fn=lambda a: rt.uninstall(a.id))
    p = sp.add_parser("order"); p.add_argument("kind", choices=rt.KINDS); p.add_argument("ids", nargs="+")
    p.set_defaults(fn=lambda a: rt.save_config({**rt.load_config(), "order": {**rt.load_config().get("order", {}), a.kind: a.ids}}))
    for name, fn in (("test", cmd_test), ("compare", cmd_compare)):
        p = sp.add_parser(name)
        p.add_argument("id" if name == "test" else "kind")
        for f in ("--image", "--video", "--ref", "--audio", "--text", "--out-dir"):
            p.add_argument(f)
        p.add_argument("--lang", default="en")
        p.set_defaults(fn=fn)
    p = sp.add_parser("draft"); p.add_argument("url"); p.add_argument("--kind", choices=rt.KINDS, default="tts"); p.add_argument("--save", action="store_true")
    p.set_defaults(fn=cmd_draft)
    p = sp.add_parser("add"); p.add_argument("dir"); p.set_defaults(fn=cmd_add)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
