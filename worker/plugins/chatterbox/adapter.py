"""Voice clone with Chatterbox (MIT, Resemble AI). Runs inside the tts venv.

Contract: --text-file T --ref R --lang L --out OUT.wav
"""
import argparse
import os
import re
import sys
import time

import torch
import torchaudio as ta


def chunks(text: str, limit: int = 180):
    """Split into sentence groups <= limit chars — Chatterbox degrades on very long inputs."""
    sentences = re.split(r"(?<=[.!?।])\s+", text.strip())
    out, cur = [], ""
    for s in sentences:
        if cur and len(cur) + len(s) + 1 > limit:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out


# Delivery. exaggeration: 0.5 = like your reference, higher = more dramatic (too high sounds acted/robotic).
# cfg_weight: lower = looser, more conversational pacing. Owner picked the "energetic" A/B sample (0.62 / 0.3).
EXAG = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.62"))
CFG = float(os.environ.get("CHATTERBOX_CFG", "0.3"))
TEMP = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.8"))


def trim(wav, sr, thresh=0.012):
    """Drop leading/trailing near-silence so the pauses we add are the only pauses (even rhythm reads as robotic)."""
    x = wav.abs().squeeze(0)
    idx = (x > thresh).nonzero()
    if len(idx) == 0:
        return wav
    a = max(0, int(idx[0]) - int(sr * 0.03))
    b = min(x.shape[-1], int(idx[-1]) + int(sr * 0.06))
    return wav[..., a:b]


def pause_after(chunk: str, sr: int, i: int):
    """Human-ish gaps: a beat after questions/exclamations, shorter after statements, slightly varied."""
    base = 0.34 if chunk.rstrip().endswith(("?", "!")) else 0.24
    jitter = ((i * 37) % 9 - 4) * 0.012
    return torch.zeros(1, int(sr * max(0.12, base + jitter)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    ref, text_file, out, lang = a.ref, a.text_file, a.out, a.lang
    text = open(text_file, encoding="utf-8").read()
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    t0 = time.time()
    if lang == "en":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=device)
        gen = lambda t: model.generate(t, audio_prompt_path=ref, exaggeration=EXAG, cfg_weight=CFG, temperature=TEMP)
    else:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS, SUPPORTED_LANGUAGES

        if lang not in SUPPORTED_LANGUAGES:
            raise SystemExit(f"language {lang} not supported by Chatterbox multilingual: {sorted(SUPPORTED_LANGUAGES)}")
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        gen = lambda t: model.generate(t, language_id=lang, audio_prompt_path=ref, exaggeration=EXAG, cfg_weight=CFG)
    print(f"[tts] model loaded on {device} in {time.time() - t0:.0f}s", flush=True)
    parts = []
    for i, c in enumerate(chunks(text)):
        t1 = time.time()
        wav = trim(gen(c), model.sr)
        parts += [wav, pause_after(c, model.sr, i)]
        print(f"[tts] chunk {i + 1}: {len(c)} chars in {time.time() - t1:.0f}s", flush=True)
    ta.save(out, torch.cat(parts, dim=-1), model.sr)
    print(f"[tts] done in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
