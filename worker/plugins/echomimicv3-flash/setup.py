import glob
import os
import shutil

from huggingface_hub import snapshot_download

data = os.environ["PLUGIN_DATA"]
flash = os.path.join(data, "flash")
os.makedirs(os.path.join(flash, "transformer"), exist_ok=True)
snapshot_download("alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP", local_dir=os.path.join(flash, "Wan2.1-Fun-V1.1-1.3B-InP"))
snapshot_download("TencentGameMate/chinese-wav2vec2-base", local_dir=os.path.join(flash, "chinese-wav2vec2-base"))
p = snapshot_download("BadToBest/EchoMimicV3", allow_patterns=["echomimicv3-flash-pro/*"])
st = sorted(glob.glob(os.path.join(p, "echomimicv3-flash-pro", "**", "*.safetensors"), recursive=True))
if not st:
    raise SystemExit("flash transformer weights not found in BadToBest/EchoMimicV3/echomimicv3-flash-pro")
shutil.copy(st[0], os.path.join(flash, "transformer", "diffusion_pytorch_model.safetensors"))
print("[echomimicv3] weights ready")
