"""LatentSync lip-sync. Contract: --video V --audio A --out OUT.mp4"""
import argparse
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.environ["PLUGIN_DIR"], ".."))
from _common import fit_clip_to_audio  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--video", required=True)
ap.add_argument("--audio", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
repo = os.environ["PLUGIN_REPO"]
work = tempfile.mkdtemp(prefix="ls-")
src = fit_clip_to_audio(a.video, a.audio, os.path.join(work, "src.mp4"))
wav = os.path.join(work, "voice.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", a.audio, "-ac", "1", "-ar", "16000", wav], check=True)
cfg = "configs/unet/stage2_512.yaml" if os.environ.get("LATENTSYNC_VERSION", "1.5") == "1.6" else "configs/unet/stage2.yaml"
subprocess.run([sys.executable, "-m", "scripts.inference", "--unet_config_path", cfg, "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
                "--inference_steps", os.environ.get("LATENTSYNC_STEPS", "20"), "--guidance_scale", "1.5", "--enable_deepcache",
                "--video_path", src, "--audio_path", wav, "--video_out_path", a.out], cwd=repo, check=True)
