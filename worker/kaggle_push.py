#!/usr/bin/env python3
"""Push a one-shot Kaggle GPU job that runs the free worker (free: ~30 GPU hours/week).

Kaggle needs a phone-verified account (for internet access in notebooks).
env: KAGGLE_USERNAME, KAGGLE_KEY (kaggle.com -> Settings -> API -> Create New Token),
     APP_URL, WORKER_SECRET, WORKER_KINDS (default "avatar").
The kernel is PRIVATE; it embeds APP_URL + WORKER_SECRET so it can call your app.
"""
import base64
import io
import zipfile
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
user = os.environ["KAGGLE_USERNAME"]
# Ship the whole worker directory (runtime, plugins, adapters) as one zip inside the kernel.
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, names in os.walk(HERE):
        for n in names:
            if "__pycache__" in root or n.endswith(".pyc"):
                continue
            full = os.path.join(root, n)
            z.write(full, os.path.relpath(full, HERE))
bundle = base64.b64encode(buf.getvalue()).decode()
env = {
    "APP_URL": os.environ["APP_URL"],
    "WORKER_SECRET": os.environ["WORKER_SECRET"],
    "WORKER_KINDS": os.environ.get("WORKER_KINDS", "lipsync,avatar"),
    "WORKER_PLUGINS": os.environ.get("WORKER_PLUGINS", "latentsync sadtalker"),
    "IDLE_EXIT_SEC": os.environ.get("IDLE_EXIT_SEC", "600"),
    "MAX_RUNTIME_SEC": os.environ.get("MAX_RUNTIME_SEC", "30000"),
    "WORKER_NAME": "kaggle-gpu",
    "WORKER_HOME": "/kaggle/working/w",
    "SADTALKER_BATCH": "16",
    "LATENTSYNC_VERSION": "1.5",  # 8 GB — fits Kaggle's 16 GB T4
}
script = f'''
import base64, io, os, subprocess, zipfile
zipfile.ZipFile(io.BytesIO(base64.b64decode("{bundle}"))).extractall("/kaggle/working/worker")
os.environ.update({env!r})
subprocess.run(["bash", "/kaggle/working/worker/setup.sh"], check=True)
subprocess.run(["python3", "/kaggle/working/worker/free_worker.py"], check=True)
'''
d = tempfile.mkdtemp()
open(os.path.join(d, "run.py"), "w").write(script)
json.dump({
    "id": f"{user}/shorts-autopilot-worker",
    "title": "shorts-autopilot-worker",
    "code_file": "run.py",
    "language": "python",
    "kernel_type": "script",
    "is_private": True,
    "enable_gpu": True,
    "enable_internet": True,
    "dataset_sources": [], "competition_sources": [], "kernel_sources": [],
}, open(os.path.join(d, "kernel-metadata.json"), "w"))
r = subprocess.run(["kaggle", "kernels", "push", "-p", d], capture_output=True, text=True)
print(r.stdout, r.stderr)
sys.exit(r.returncode)
