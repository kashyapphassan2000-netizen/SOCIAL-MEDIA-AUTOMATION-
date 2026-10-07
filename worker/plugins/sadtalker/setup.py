"""Patch SadTalker for NumPy>=1.24 and download checkpoints from Hugging Face."""
import os
import shutil

from huggingface_hub import hf_hub_download as d

repo, data = os.environ["PLUGIN_REPO"], os.environ["PLUGIN_DATA"]
f = os.path.join(repo, "src", "face3d", "util", "preprocess.py")
s = open(f).read()
s = s.replace("np.array([w0, h0, s, t[0], t[1]])", "np.array([w0, h0, s, float(np.asarray(t[0]).reshape(-1)[0]), float(np.asarray(t[1]).reshape(-1)[0])])")
open(f, "w").write(s)
os.makedirs(os.path.join(data, "gfpgan", "weights"), exist_ok=True)
for name in ["SadTalker_V0.0.2_256.safetensors", "mapping_00109-model.pth.tar", "mapping_00229-model.pth.tar"]:
    shutil.copy(d("vinthony/SadTalker-V002rc", name), os.path.join(data, name))
for name in ["alignment_WFLW_4HG.pth", "detection_Resnet50_Final.pth"]:
    shutil.copy(d("camenduru/SadTalker", f"new/gfpgan/weights/{name}"), os.path.join(data, "gfpgan", "weights", name))
print("[sadtalker] ready")
