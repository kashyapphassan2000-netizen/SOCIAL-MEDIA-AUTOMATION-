"""MuseTalk lip-sync. Contract: --video V --audio A --out OUT.mp4"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.environ["PLUGIN_DIR"], ".."))
from _common import fit_clip_to_audio, newest  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--video", required=True)
ap.add_argument("--audio", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
repo = os.environ["PLUGIN_REPO"]
work = tempfile.mkdtemp(prefix="mt-")
src = fit_clip_to_audio(a.video, a.audio, os.path.join(work, "src.mp4"))
wav = os.path.join(work, "voice.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", a.audio, "-ac", "1", "-ar", "16000", wav], check=True)
cfg = os.path.join(work, "task.yaml")
open(cfg, "w").write(f'task_0:\n  video_path: "{src}"\n  audio_path: "{wav}"\n  bbox_shift: {int(os.environ.get("MUSETALK_BBOX_SHIFT", "0"))}\n')
res = os.path.join(work, "results")
subprocess.run([sys.executable, "-m", "scripts.inference", "--inference_config", cfg, "--result_dir", res,
                "--unet_model_path", "models/musetalkV15/unet.pth", "--unet_config", "models/musetalkV15/musetalk.json", "--version", "v15"],
               cwd=repo, check=True)
out = newest(res)
if not out:
    raise SystemExit("MuseTalk produced no video")
shutil.copy(out, a.out)
