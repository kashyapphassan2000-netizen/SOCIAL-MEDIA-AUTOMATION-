"""Talking head from one photo + audio with SadTalker (MIT, Tencent AI Lab). Runs inside the sadtalker venv.

usage: python avatar_sadtalker.py <sadtalker_src_dir> <checkpoint_dir> <image> <audio.wav> <out.mp4>
"""
import os
import shutil
import sys
import tempfile
import time
import types

import numpy as np

# SadTalker predates NumPy 1.24 / 2.x — restore the removed aliases it still uses.
for _n, _t in (("float", float), ("int", int), ("bool", bool), ("complex", complex), ("object", object), ("str", str)):
    if not hasattr(np, _n):
        setattr(np, _n, _t)

# Face enhancer (GFPGAN) is not used; stub it so its heavy deps are not needed.
_g = types.ModuleType("gfpgan")
_g.GFPGANer = None
sys.modules.setdefault("gfpgan", _g)


def main():
    src, ckpt, image, audio, out = sys.argv[1:6]
    size = int(os.environ.get("SADTALKER_SIZE", "256"))
    batch = int(os.environ.get("SADTALKER_BATCH", "8"))
    sys.path.insert(0, src)
    os.chdir(ckpt)  # facexlib weights are resolved relative to cwd (gfpgan/weights)
    from src.gradio_demo import SadTalker  # noqa: E402

    t0 = time.time()
    work = tempfile.mkdtemp(prefix="st-")
    img = os.path.join(work, "face" + os.path.splitext(image)[1])
    wav = os.path.join(work, "voice.wav")
    shutil.copy(image, img)
    shutil.copy(audio, wav)
    st = SadTalker(checkpoint_path=ckpt, config_path=os.path.join(src, "src", "config"))
    path = st.test(
        img, wav,
        preprocess=os.environ.get("SADTALKER_PREPROCESS", "full"),  # keep the whole photo, animate the face
        still_mode=True,  # natural, restrained head motion — required for "full"
        use_enhancer=False,
        batch_size=batch,
        size=size,
        result_dir=os.path.join(work, "results"),
    )
    shutil.copy(path, out)
    shutil.rmtree(work, ignore_errors=True)
    print(f"[avatar] done in {time.time() - t0:.0f}s -> {out}", flush=True)


if __name__ == "__main__":
    main()
