#!/usr/bin/env python3
"""Push a one-shot Kaggle GPU job that runs the free worker (free: ~30 GPU hours/week).

Kaggle needs a phone-verified account (for internet access in notebooks).
env: KAGGLE_USERNAME, KAGGLE_KEY (kaggle.com -> Settings -> API -> Create New Token),
     APP_URL, WORKER_SECRET, WORKER_KINDS (default "avatar").
The kernel is PRIVATE; it embeds APP_URL + WORKER_SECRET so it can call your app.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
user = os.environ["KAGGLE_USERNAME"]
files = {n: base64.b64encode(open(os.path.join(HERE, n), "rb").read()).decode() for n in ("setup.sh", "free_worker.py", "tts_chatterbox.py", "avatar_sadtalker.py")}
env = {
    "APP_URL": os.environ["APP_URL"],
    "WORKER_SECRET": os.environ["WORKER_SECRET"],
    "WORKER_KINDS": os.environ.get("WORKER_KINDS", "avatar"),
    "IDLE_EXIT_SEC": os.environ.get("IDLE_EXIT_SEC", "600"),
    "MAX_RUNTIME_SEC": os.environ.get("MAX_RUNTIME_SEC", "30000"),
    "WORKER_NAME": "kaggle-gpu",
    "WORKER_HOME": "/kaggle/working/w",
    "SADTALKER_BATCH": "16",
}
script = f'''
import base64, os, subprocess
os.makedirs("/kaggle/working/worker", exist_ok=True)
for name, data in {files!r}.items():
    open(f"/kaggle/working/worker/{{name}}", "wb").write(base64.b64decode(data))
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
