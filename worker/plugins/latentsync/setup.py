import os
import shutil

from huggingface_hub import hf_hub_download as d

v = os.environ.get("LATENTSYNC_VERSION", "1.5")
ck = os.path.join(os.environ["PLUGIN_REPO"], "checkpoints")
os.makedirs(os.path.join(ck, "whisper"), exist_ok=True)
repo = f"ByteDance/LatentSync-{v}"
shutil.copy(d(repo, "latentsync_unet.pt"), os.path.join(ck, "latentsync_unet.pt"))
shutil.copy(d(repo, "whisper/tiny.pt"), os.path.join(ck, "whisper", "tiny.pt"))
print(f"[latentsync] {v} weights ready")
