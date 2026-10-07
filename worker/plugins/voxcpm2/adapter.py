"""VoxCPM2 voice clone. Contract: --text-file --ref --lang --out"""
import argparse
import os
import re
import time

import numpy as np
import soundfile as sf
import torch

p = argparse.ArgumentParser()
p.add_argument("--text-file", required=True)
p.add_argument("--ref", required=True)
p.add_argument("--lang", default="en")
p.add_argument("--out", required=True)
a = p.parse_args()

from voxcpm import VoxCPM  # noqa: E402

t0 = time.time()
device = "cuda" if torch.cuda.is_available() else "cpu"
model = VoxCPM.from_pretrained(os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2"), load_denoiser=False, optimize=device == "cuda", device=device)
print(f"[voxcpm2] loaded on {device} in {time.time() - t0:.0f}s", flush=True)
text = open(a.text_file, encoding="utf-8").read().strip()
# Sentence groups keep prosody natural and avoid long-input drift.
sentences = re.split(r"(?<=[.!?।])\s+", text)
chunks, cur = [], ""
for s in sentences:
    if cur and len(cur) + len(s) > 220:
        chunks.append(cur)
        cur = s
    else:
        cur = f"{cur} {s}".strip()
if cur:
    chunks.append(cur)
sr = model.tts_model.sample_rate
parts = []
for i, c in enumerate(chunks):
    t1 = time.time()
    wav = model.generate(text=c, reference_wav_path=a.ref, cfg_value=2.0, inference_timesteps=int(os.environ.get("VOXCPM_STEPS", "10")))
    parts += [np.asarray(wav, dtype=np.float32), np.zeros(int(sr * 0.12), dtype=np.float32)]
    print(f"[voxcpm2] chunk {i + 1}/{len(chunks)} in {time.time() - t1:.0f}s", flush=True)
sf.write(a.out, np.concatenate(parts), sr)
print(f"[voxcpm2] done in {time.time() - t0:.0f}s", flush=True)
