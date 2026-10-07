"""Word timings for captions. Contract: --audio A --text-file T --lang L --out OUT.json

Whisper transcribes the audio with word timestamps; the ORIGINAL script words are then aligned to
the recognised words (difflib) so captions show exactly what was written, at the time it was spoken.
"""
import argparse
import difflib
import json
import os
import re

from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("--audio", required=True)
ap.add_argument("--text-file", required=True)
ap.add_argument("--lang", default="en")
ap.add_argument("--out", required=True)
a = ap.parse_args()

model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="auto", compute_type="int8")
segments, _ = model.transcribe(a.audio, language=a.lang or None, word_timestamps=True, vad_filter=False)
heard = [w for s in segments for w in (s.words or [])]
script = open(a.text_file, encoding="utf-8").read().split()
norm = lambda w: re.sub(r"[^\w]", "", w.lower())
sm = difflib.SequenceMatcher(a=[norm(w) for w in script], b=[norm(w.word) for w in heard], autojunk=False)
times = [None] * len(script)
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        for k in range(i2 - i1):
            times[i1 + k] = (heard[j1 + k].start, heard[j1 + k].end)
    elif tag == "replace" and j2 > j1:
        # spread the script words over the recognised span
        s0, e0 = heard[j1].start, heard[j2 - 1].end
        n = i2 - i1
        for k in range(n):
            times[i1 + k] = (s0 + (e0 - s0) * k / n, s0 + (e0 - s0) * (k + 1) / n)
# fill gaps by interpolation between known neighbours
end_audio = heard[-1].end if heard else 0.0
for i in range(len(script)):
    if times[i] is None:
        prev = next((times[j][1] for j in range(i - 1, -1, -1) if times[j]), 0.0)
        nxt = next((times[j][0] for j in range(i + 1, len(script)) if times[j]), end_audio)
        times[i] = (prev, max(prev + 0.05, (prev + nxt) / 2))
words = [{"word": w, "start": round(t[0], 3), "end": round(t[1], 3)} for w, t in zip(script, times)]
json.dump(words, open(a.out, "w"), ensure_ascii=False)
print(f"[align] {len(words)} words, {sum(1 for t in times if t)} timed, {len(heard)} heard")
