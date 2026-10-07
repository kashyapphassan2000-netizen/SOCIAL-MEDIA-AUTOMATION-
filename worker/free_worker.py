#!/usr/bin/env python3
"""
Free worker for Shorts Autopilot — zero API cost voice cloning + talking-head rendering.

It polls your app for queued tasks, renders them with open-source models and uploads results:
  tts    -> Chatterbox (MIT)  : your voice from a 10 s reference, 23 languages incl. Hindi
  avatar -> SadTalker  (MIT)  : your photo talking in sync with the audio

Runs anywhere with Python 3.10+ and ffmpeg: GitHub Actions (free CPU), Kaggle (free GPU),
Google Colab, or your own PC. Stdlib only — the models run in their own venvs (see setup.sh).

env:
  APP_URL, WORKER_SECRET          required
  WORKER_HOME                     where setup.sh put venvs/models (default ~/.shorts-worker)
  WORKER_KINDS                    "tts,avatar" (default) — e.g. only "tts" on a weak machine
  IDLE_EXIT_SEC                   exit after this long with an empty queue (default 120; 0 = never)
  MAX_RUNTIME_SEC                 stop taking new tasks after this (default 19800 = 5.5 h, GitHub's limit is 6 h)
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

APP = os.environ.get("APP_URL", "").rstrip("/")
SECRET = os.environ.get("WORKER_SECRET", "")
HOME = os.path.expanduser(os.environ.get("WORKER_HOME", "~/.shorts-worker"))
KINDS = [k.strip() for k in os.environ.get("WORKER_KINDS", "tts,avatar").split(",") if k.strip()]
IDLE_EXIT = int(os.environ.get("IDLE_EXIT_SEC", "120"))
MAX_RUNTIME = int(os.environ.get("MAX_RUNTIME_SEC", "19800"))
NAME = os.environ.get("WORKER_NAME", f"{socket.gethostname()}-{os.getpid()}")
UPLOAD_LIMIT = 4_200_000  # Vercel request body limit is 4.5 MB

TTS_PY = os.path.join(HOME, "tts-venv", "bin", "python")
ST_PY = os.path.join(HOME, "st-venv", "bin", "python")
ST_SRC = os.path.join(HOME, "sadtalker")
ST_CKPT = os.path.join(HOME, "sadtalker-ckpt")
HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def api(path, data=None, files=None, timeout=60):
    url = f"{APP}{path}"
    headers = {"Authorization": f"Bearer {SECRET}"}
    body = None
    if files is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in (data or {}).items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for k, (fname, blob, ctype) in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + blob + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 3:
                raise RuntimeError(f"{path}: HTTP {e.code} {e.read()[:300]!r}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == 3:
                raise
            log("network error, retrying:", e)
        time.sleep(3 * (attempt + 1))


def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "shorts-worker"})
    with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def run(cmd, env=None, timeout=4 * 3600):
    log("$", " ".join(cmd[:3]), "...")
    subprocess.run(cmd, check=True, timeout=timeout, env={**os.environ, **(env or {})})


def do_tts(task, work):
    inp = task["input"]
    ref = fetch(inp["refAudioUrl"], os.path.join(work, "ref.src"))
    ref_wav = os.path.join(work, "ref.wav")
    ff("-i", ref, "-ac", "1", "-ar", "24000", "-t", "15", ref_wav)
    txt = os.path.join(work, "text.txt")
    open(txt, "w", encoding="utf-8").write(inp["text"])
    out_wav = os.path.join(work, "out.wav")
    run([TTS_PY, os.path.join(HERE, "tts_chatterbox.py"), ref_wav, txt, out_wav, str(inp.get("language", "en"))])
    out = os.path.join(work, "voice.mp3")
    ff("-i", out_wav, "-af", "loudnorm=I=-16:TP=-1.5", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", out)
    return out, "voice.mp3", "audio/mpeg"


def do_avatar(task, work):
    inp = task["input"]
    img_src = fetch(inp["imageUrl"], os.path.join(work, "img.src"))
    aud_src = fetch(inp["audioUrl"], os.path.join(work, "aud.src"))
    img = os.path.join(work, "face.png")
    # 720 px wide keeps the face sharp while keeping CPU paste-back fast.
    ff("-i", img_src, "-vf", "scale='min(720,iw)':-2", "-frames:v", "1", img)
    wav = os.path.join(work, "voice.wav")
    ff("-i", aud_src, "-ac", "1", "-ar", "16000", wav)
    raw = os.path.join(work, "raw.mp4")
    run([ST_PY, os.path.join(HERE, "avatar_sadtalker.py"), ST_SRC, ST_CKPT, img, wav, raw])
    out = os.path.join(work, "avatar.mp4")
    for crf in (24, 28, 32, 36):
        ff("-i", raw, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
           "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", out)
        if os.path.getsize(out) <= UPLOAD_LIMIT:
            break
    return out, "avatar.mp4", "video/mp4"


HANDLERS = {"tts": do_tts, "avatar": do_avatar}


def main():
    if not APP or not SECRET:
        sys.exit("APP_URL and WORKER_SECRET are required")
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH")
    kinds = [k for k in KINDS if k in HANDLERS]
    started = time.time()
    idle_since = time.time()
    log(f"worker {NAME} polling {APP} for {kinds}")
    while time.time() - started < MAX_RUNTIME:
        status, body = api("/api/worker/claim", {"kinds": kinds, "worker": NAME})
        if status == 204 or not body:
            if IDLE_EXIT and time.time() - idle_since > IDLE_EXIT:
                log("queue empty — exiting")
                return
            time.sleep(15)
            continue
        task = body["task"]
        log(f"task {task['id']} ({task['kind']}) attempt {task['attempts']}")
        work = tempfile.mkdtemp(prefix="sw-")
        t0 = time.time()
        try:
            path, fname, ctype = HANDLERS[task["kind"]](task, work)
            size = os.path.getsize(path)
            if size > UPLOAD_LIMIT:
                raise RuntimeError(f"output {size} bytes exceeds upload limit")
            api("/api/worker/complete", {"taskId": task["id"], "meta": json.dumps({"seconds": round(time.time() - t0), "worker": NAME})},
                files={"file": (fname, open(path, "rb").read(), ctype)}, timeout=180)
            log(f"task {task['id']} done in {time.time() - t0:.0f}s ({size // 1024} KB)")
        except Exception as e:  # report and keep serving other tasks
            log(f"task {task['id']} FAILED: {e}")
            try:
                api("/api/worker/complete", {"taskId": task["id"], "error": f"{type(e).__name__}: {e}"[:900]}, files={})
            except Exception as e2:
                log("could not report failure:", e2)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        idle_since = time.time()
    log("max runtime reached — exiting (remaining tasks go to the next run)")


if __name__ == "__main__":
    main()
