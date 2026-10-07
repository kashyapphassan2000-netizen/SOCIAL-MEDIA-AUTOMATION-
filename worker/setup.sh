#!/usr/bin/env bash
# Idempotent install of the free-worker plugins into $WORKER_HOME (default ~/.shorts-worker).
# Needs python3.10+/3.11, ffmpeg, git. GPU optional (NVIDIA auto-detected → CUDA builds + GPU plugins).
#   WORKER_PLUGINS="voxcpm2 faster-whisper latentsync"   override the default selection
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-$(command -v python3.11 || command -v python3.10 || command -v python3)}"
command -v uv >/dev/null || "$PY" -m pip install -q --user uv || pip install -q uv
export PATH="$HOME/.local/bin:$PATH"
if [ -z "${WORKER_PLUGINS:-}" ]; then
  KINDS="${WORKER_KINDS:-tts,lipsync,avatar}"
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    # GPU: most natural voice + real-clip lip-sync + gesture avatar
    P=""; [[ "$KINDS" == *tts* ]] && P="$P voxcpm2 chatterbox faster-whisper"
    [[ "$KINDS" == *lipsync* ]] && P="$P latentsync"
    [[ "$KINDS" == *avatar* ]] && P="$P sadtalker"
  else
    # CPU: what is actually usable without a GPU
    P=""; [[ "$KINDS" == *tts* ]] && P="$P chatterbox faster-whisper"
    [[ "$KINDS" == *avatar* ]] && P="$P sadtalker"
  fi
  WORKER_PLUGINS="$P"
fi
echo "[setup] plugins:$WORKER_PLUGINS"
[ -n "${WORKER_PLUGINS// }" ] && "$PY" "$HERE/plugin_cli.py" install $WORKER_PLUGINS
"$PY" "$HERE/plugin_cli.py" list
