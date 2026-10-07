import os
import shutil
import subprocess
import urllib.request

from huggingface_hub import hf_hub_download as d

m = os.path.join(os.environ["PLUGIN_REPO"], "models")
def get(repo, name, dest_dir, dest_name=None):
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy(d(repo, name), os.path.join(dest_dir, dest_name or os.path.basename(name)))
get("TMElyralab/MuseTalk", "musetalkV15/musetalk.json", f"{m}/musetalkV15")
get("TMElyralab/MuseTalk", "musetalkV15/unet.pth", f"{m}/musetalkV15")
for f in ["config.json", "diffusion_pytorch_model.bin"]:
    get("stabilityai/sd-vae-ft-mse", f, f"{m}/sd-vae")
for f in ["config.json", "pytorch_model.bin", "preprocessor_config.json"]:
    get("openai/whisper-tiny", f, f"{m}/whisper")
get("yzd-v/DWPose", "dw-ll_ucoco_384.pth", f"{m}/dwpose")
get("ByteDance/LatentSync", "latentsync_syncnet.pt", f"{m}/syncnet")
fp = f"{m}/face-parse-bisent"
os.makedirs(fp, exist_ok=True)
urllib.request.urlretrieve("https://download.pytorch.org/models/resnet18-5c106cde.pth", f"{fp}/resnet18-5c106cde.pth")
try:  # HF mirror first, Google Drive (official) as fallback
    get("ManyOtherFunctions/face-parse-bisent", "79999_iter.pth", fp)
except Exception:
    subprocess.run(["gdown", "--id", "154JgKpzCPW82qINcVieuPH3fZ2e0P812", "-O", f"{fp}/79999_iter.pth"], check=True)
print("[musetalk] weights ready")
