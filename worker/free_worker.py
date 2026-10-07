#!/usr/bin/env python3
"""
Free worker for Shorts Autopilot: zero-API-cost voice cloning, lip-sync and talking avatars.

Polls your app for queued tasks, renders them with open-source model PLUGINS (see plugin_cli.py)
and uploads the results:
  tts      voice clone        (voxcpm2, chatterbox, ... + faster-whisper word timings for captions)
  lipsync  real-clip lip-sync (latentsync, musetalk, ...)   <- most natural: your real body + gestures
  avatar   photo -> video     (echomimicv3-flash with hand gestures, sadtalker, ...)

Each kind tries its plugins in your preferred order and falls back to the next on failure.
Runs on GitHub Actions (free CPU), Kaggle (free GPU), your own PC (Studio app) — stdlib only.

env:
  APP_URL, WORKER_SECRET          required
  WORKER_HOME                     plugins/venvs/weights location (default ~/.shorts-worker)
  WORKER_KINDS                    default "tts,lipsync,avatar"
  IDLE_EXIT_SEC                   exit after this long with an empty queue (default 120; 0 = never)
  MAX_RUNTIME_SEC                 stop taking tasks after this (default 19800 = 5.5 h)
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plugin_runtime as rt  # noqa: E402

APP = os.environ.get("APP_URL", "").rstrip("/")
SECRET = os.environ.get("WORKER_SECRET", "")
KINDS = [k.strip() for k in os.environ.get("WORKER_KINDS", "tts,lipsync,avatar").split(",") if k.strip()]
IDLE_EXIT = int(os.environ.get("IDLE_EXIT_SEC", "120"))
MAX_RUNTIME = int(os.environ.get("MAX_RUNTIME_SEC", "19800"))
NAME = os.environ.get("WORKER_NAME", f"{socket.gethostname()}-{os.getpid()}")
UPLOAD_LIMIT = 4_200_000  # Vercel request body limit is 4.5 MB
log = rt.log


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
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def compress_video(raw, audio, out):
    """H.264 + AAC under the upload limit; drops resolution only if quality steps are not enough."""
    for scale, crf in ((720, 23), (720, 27), (720, 31), (540, 31), (540, 35)):
        ff("-i", raw, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
           "-pix_fmt", "yuv420p", "-vf", f"scale='min({scale},iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2",
           "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", out)
        if os.path.getsize(out) <= UPLOAD_LIMIT:
            return out
    return out


def do_tts(task, work):
    inp = task["input"]
    ref = fetch(inp["refAudioUrl"], os.path.join(work, "ref.src"))
    ref_wav = os.path.join(work, "ref.wav")
    ff("-i", ref, "-ac", "1", "-ar", "24000", "-t", "15", ref_wav)
    txt = os.path.join(work, "text.txt")
    open(txt, "w", encoding="utf-8").write(inp["text"])
    lang = str(inp.get("language", "en"))
    out_wav = os.path.join(work, "out.wav")
    plugin, secs = rt.run_kind("tts", {"text_file": txt, "ref": ref_wav, "lang": lang, "out": out_wav})
    meta = {"plugin": plugin, "render_seconds": round(secs)}
    # Word-level timings make captions land exactly on the spoken word.
    try:
        wj = os.path.join(work, "words.json")
        rt.run_kind("align", {"audio": out_wav, "text_file": txt, "lang": lang, "out": wj})
        meta["words"] = json.load(open(wj, encoding="utf-8"))
    except Exception as e:
        log("alignment skipped:", e)
    out = os.path.join(work, "voice.mp3")
    ff("-i", out_wav, "-af", "loudnorm=I=-16:TP=-1.5", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", out)
    return out, "voice.mp3", "audio/mpeg", meta


def _video_task(task, work, kind):
    inp = task["input"]
    aud = fetch(inp["audioUrl"], os.path.join(work, "aud.src"))
    wav = os.path.join(work, "voice.wav")
    ff("-i", aud, "-ac", "1", "-ar", "16000", wav)
    raw = os.path.join(work, "raw.mp4")
    if kind == "lipsync":
        clip = fetch(inp["videoUrl"], os.path.join(work, "clip.src"))
        plugin, secs = rt.run_kind("lipsync", {"video": clip, "audio": wav, "out": raw})
    else:
        img_src = fetch(inp["imageUrl"], os.path.join(work, "img.src"))
        img = os.path.join(work, "face.png")
        ff("-i", img_src, "-vf", "scale='min(720,iw)':-2", "-frames:v", "1", img)
        plugin, secs = rt.run_kind("avatar", {"image": img, "audio": wav, "out": raw})
    out = compress_video(raw, wav, os.path.join(work, "video.mp4"))
    return out, "video.mp4", "video/mp4", {"plugin": plugin, "render_seconds": round(secs)}


HANDLERS = {"tts": do_tts, "lipsync": lambda t, w: _video_task(t, w, "lipsync"), "avatar": lambda t, w: _video_task(t, w, "avatar")}


def main():
    if not APP or not SECRET:
        sys.exit("APP_URL and WORKER_SECRET are required")
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH")
    kinds = [k for k in KINDS if k in HANDLERS]
    started = idle_since = time.time()
    log(f"worker {NAME} polling {APP} for {kinds} (gpu={rt.has_gpu()})")
    while time.time() - started < MAX_RUNTIME:
        status, body = api("/api/worker/claim", {"kinds": kinds, "worker": NAME, "gpu": rt.has_gpu()})
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
            path, fname, ctype, meta = HANDLERS[task["kind"]](task, work)
            size = os.path.getsize(path)
            if size > UPLOAD_LIMIT:
                raise RuntimeError(f"output {size} bytes exceeds upload limit")
            meta.update({"seconds": round(time.time() - t0), "worker": NAME})
            api("/api/worker/complete", {"taskId": task["id"], "meta": json.dumps(meta)}, files={"file": (fname, open(path, "rb").read(), ctype)}, timeout=180)
            log(f"task {task['id']} done by {meta.get('plugin')} in {time.time() - t0:.0f}s ({size // 1024} KB)")
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
