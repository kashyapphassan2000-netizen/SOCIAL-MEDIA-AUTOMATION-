"""Voice clone with Chatterbox (MIT, Resemble AI). Runs inside the tts venv.

usage: python tts_chatterbox.py <ref_audio> <text_file> <out.wav> <language>
"""
import re
import sys
import time

import torch
import torchaudio as ta


def chunks(text: str, limit: int = 260):
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


def main():
    ref, text_file, out, lang = sys.argv[1], sys.argv[2], sys.argv[3], (sys.argv[4] if len(sys.argv) > 4 else "en")
    text = open(text_file, encoding="utf-8").read()
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    t0 = time.time()
    if lang == "en":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=device)
        gen = lambda t: model.generate(t, audio_prompt_path=ref, exaggeration=0.55, cfg_weight=0.5)
    else:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS, SUPPORTED_LANGUAGES

        if lang not in SUPPORTED_LANGUAGES:
            raise SystemExit(f"language {lang} not supported by Chatterbox multilingual: {sorted(SUPPORTED_LANGUAGES)}")
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        gen = lambda t: model.generate(t, language_id=lang, audio_prompt_path=ref, exaggeration=0.55, cfg_weight=0.5)
    print(f"[tts] model loaded on {device} in {time.time() - t0:.0f}s", flush=True)
    pause = torch.zeros(1, int(model.sr * 0.12))
    parts = []
    for i, c in enumerate(chunks(text)):
        t1 = time.time()
        wav = gen(c)
        parts += [wav, pause]
        print(f"[tts] chunk {i + 1}: {len(c)} chars in {time.time() - t1:.0f}s", flush=True)
    ta.save(out, torch.cat(parts, dim=-1), model.sr)
    print(f"[tts] done in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
