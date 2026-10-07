"""EchoMimicV3-Flash. Contract: --image I --audio A --out OUT.mp4"""
import argparse
import math
import os
import shlex
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.environ["PLUGIN_DIR"], ".."))
from _common import duration, mux_audio, newest  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--image", required=True)
ap.add_argument("--audio", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
repo, flash = os.environ["PLUGIN_REPO"], os.path.join(os.environ["PLUGIN_DATA"], "flash")
work = tempfile.mkdtemp(prefix="em-")
wav = os.path.join(work, "voice.wav")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", a.audio, "-ac", "1", "-ar", "16000", wav], check=True)
frames = int(math.ceil(duration(wav) * 25))
frames = frames + (4 - (frames - 1) % 4) % 4  # Wan models need 4k+1 frames
size = os.environ.get("ECHOMIMIC_SIZE", "768 768").split()
cmd = [sys.executable, "infer_flash.py",
       "--image_path", a.image, "--audio_path", wav,
       "--prompt", os.environ.get("ECHOMIMIC_PROMPT", "A confident person is speaking to the camera with natural hand gestures, professional studio lighting."),
       "--num_inference_steps", "8", "--config_path", "config/config.yaml",
       "--model_name", os.path.join(flash, "Wan2.1-Fun-V1.1-1.3B-InP"), "--ckpt_idx", "50000",
       "--transformer_path", os.path.join(flash, "transformer", "diffusion_pytorch_model.safetensors"),
       "--save_path", work, "--wav2vec_model_dir", os.path.join(flash, "chinese-wav2vec2-base"),
       "--sampler_name", "Flow_Unipc", "--video_length", str(frames),
       "--guidance_scale", "6.0", "--audio_guidance_scale", "3.0", "--audio_scale", "1.0", "--neg_scale", "1.0", "--neg_steps", "0",
       "--seed", "43", "--enable_teacache", "--teacache_threshold", "0.1", "--num_skip_start_steps", "5", "--riflex_k", "6",
       "--ulysses_degree", "1", "--ring_degree", "1", "--weight_dtype", "bfloat16", "--sample_size", *size,
       "--fps", "25", "--add_prompt", "", "--negative_prompt", "", "--shift", "5.0",
       *shlex.split(os.environ.get("ECHOMIMIC_EXTRA_ARGS", ""))]
subprocess.run(cmd, cwd=repo, check=True)
vid = newest(work)
if not vid:
    raise SystemExit("EchoMimicV3 produced no video")
mux_audio(vid, wav, a.out)
