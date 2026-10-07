#!/usr/bin/env bash
# One-time (idempotent) install of the free worker models into $WORKER_HOME (default ~/.shorts-worker).
# Needs: python3.10/3.11, ffmpeg, git, git-lfs (optional). ~6 GB disk. Works on Linux/macOS/WSL, CPU or NVIDIA GPU.
set -euo pipefail
HOME_DIR="${WORKER_HOME:-$HOME/.shorts-worker}"
PY="${PYTHON:-$(command -v python3.11 || command -v python3.10 || command -v python3)}"
KINDS="${WORKER_KINDS:-tts,avatar}"
mkdir -p "$HOME_DIR"
cd "$HOME_DIR"
command -v uv >/dev/null || "$PY" -m pip install -q --user uv || pip install -q uv
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
if command -v nvidia-smi >/dev/null 2>&1; then TORCH_INDEX="https://download.pytorch.org/whl/cu124"; TORCH_SUFFIX=""; else TORCH_INDEX="https://download.pytorch.org/whl/cpu"; TORCH_SUFFIX="+cpu"; fi
echo "[setup] python=$PY torch index=$TORCH_INDEX home=$HOME_DIR"

if [[ "$KINDS" == *tts* && ! -f tts-venv/.ok ]]; then
  "$UV" venv -q -p "$PY" tts-venv
  VIRTUAL_ENV="$HOME_DIR/tts-venv" "$UV" pip install -q --index-strategy unsafe-best-match --extra-index-url "$TORCH_INDEX" \
    "torch==2.6.0$TORCH_SUFFIX" "torchaudio==2.6.0$TORCH_SUFFIX" "chatterbox-tts==0.1.7" "setuptools<81"
  # pre-download weights (English + multilingual) so task time is render time only
  tts-venv/bin/python -c "from huggingface_hub import snapshot_download as s; s('ResembleAI/chatterbox')"
  touch tts-venv/.ok
fi

if [[ "$KINDS" == *avatar* && ! -f st-venv/.ok ]]; then
  "$UV" venv -q -p "$PY" st-venv
  VIRTUAL_ENV="$HOME_DIR/st-venv" "$UV" pip install -q --index-strategy unsafe-best-match --extra-index-url "$TORCH_INDEX" \
    "torch==2.6.0$TORCH_SUFFIX" "torchvision==0.21.0$TORCH_SUFFIX" "numpy<2" "librosa==0.9.2" numba "face_alignment==1.3.5" \
    "imageio==2.34.0" imageio-ffmpeg resampy pydub scipy "kornia==0.6.8" tqdm "yacs==0.1.8" pyyaml joblib scikit-image \
    "facexlib==0.3.0" safetensors opencv-python-headless easydict av "setuptools<81" filterpy huggingface_hub
  touch st-venv/.ok
fi

if [[ "$KINDS" == *avatar* && ! -f sadtalker/.ok ]]; then
  rm -rf sadtalker
  # Official SadTalker code (MIT) mirrored on Hugging Face; pinned for reproducibility.
  GIT_LFS_SKIP_SMUDGE=1 git clone -q https://huggingface.co/spaces/vinthony/SadTalker sadtalker
  # Patch for NumPy >= 1.24 (ragged array creation).
  sed -i.bak 's/np.array(\[w0, h0, s, t\[0\], t\[1\]\])/np.array([w0, h0, s, float(np.asarray(t[0]).reshape(-1)[0]), float(np.asarray(t[1]).reshape(-1)[0])])/' \
    sadtalker/src/face3d/util/preprocess.py
  touch sadtalker/.ok
fi

if [[ "$KINDS" == *avatar* && ! -f sadtalker-ckpt/.ok ]]; then
  mkdir -p sadtalker-ckpt/gfpgan/weights
  st-venv/bin/python - <<'PY'
import shutil
from huggingface_hub import hf_hub_download as d
for f in ["SadTalker_V0.0.2_256.safetensors", "mapping_00109-model.pth.tar", "mapping_00229-model.pth.tar"]:
    shutil.copy(d("vinthony/SadTalker-V002rc", f), f"sadtalker-ckpt/{f}")
# facexlib face detector / landmark weights (mirrors of the official GitHub release files)
for f in ["alignment_WFLW_4HG.pth", "detection_Resnet50_Final.pth"]:
    shutil.copy(d("camenduru/SadTalker", f"new/gfpgan/weights/{f}"), f"sadtalker-ckpt/gfpgan/weights/{f}")
print("[setup] sadtalker checkpoints ready")
PY
  touch sadtalker-ckpt/.ok
fi
echo "[setup] done: $(du -sh "$HOME_DIR" | cut -f1)"
