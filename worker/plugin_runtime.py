"""
Plugin runtime for the free worker (stdlib only, Windows / Linux / macOS / WSL).

A plugin = any open-source model wrapped behind a tiny standard CLI ("adapter"), installed into
its own isolated Python environment so conflicting repos never break each other.

Layout of a plugin directory:
    plugin.json   manifest (see below)
    adapter.py    standard CLI for its kind (contract below)
    setup.py      optional, runs once after install inside the plugin venv (download weights, patch code)

Manifest fields:
    id, name, kind (tts | lipsync | avatar | align), license, homepage
    repo          optional git URL cloned into <home>/repos/<id> (exposed to the adapter as PLUGIN_REPO)
    repo_ref      optional branch/tag/commit
    python        e.g. "3.11"
    torch         optional {"torch": "2.6.0", "torchaudio": "2.6.0", "torchvision": "0.21.0"} — CUDA build when a GPU exists
    requirements  pip requirement strings (installed after torch)
    gpu           "none" | "optional" | "required";  min_vram_gb
    timeout_min   max minutes per run (default 60)

Adapter contract (all paths absolute):
    tts      adapter.py --text-file T --ref R --lang L --out OUT.wav
    lipsync  adapter.py --video V --audio A --out OUT.mp4        (re-lip-sync a real clip of you)
    avatar   adapter.py --image I --audio A --out OUT.mp4        (animate a single photo)
    align    adapter.py --audio A --text-file T --lang L --out OUT.json   ([{"word","start","end"}])
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BUILTIN_DIR = os.path.join(HERE, "plugins")
HOME = os.path.expanduser(os.environ.get("WORKER_HOME", "~/.shorts-worker"))
USER_DIR = os.path.join(HOME, "plugins")
KINDS = ("tts", "lipsync", "avatar", "align")
IS_WIN = platform.system() == "Windows"

DEFAULT_ORDER = {
    "tts": ["voxcpm2", "chatterbox"],  # GPU: VoxCPM2 is the most natural
    "lipsync": ["latentsync", "musetalk"],
    "avatar": ["echomimicv3-flash", "sadtalker"],
    "align": ["faster-whisper"],
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def has_gpu() -> bool:
    if os.environ.get("FORCE_CPU") == "1":
        return False
    return shutil.which("nvidia-smi") is not None and subprocess.run(["nvidia-smi"], capture_output=True).returncode == 0


def torch_index(cuda: str | None = None) -> str:
    if os.environ.get("TORCH_INDEX"):
        return os.environ["TORCH_INDEX"]
    return f"https://download.pytorch.org/whl/{cuda or 'cu124'}" if has_gpu() else "https://download.pytorch.org/whl/cpu"


# ---------------------------------------------------------------- discovery
def plugin_dirs():
    for base in (BUILTIN_DIR, USER_DIR):
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                d = os.path.join(base, name)
                if os.path.isfile(os.path.join(d, "plugin.json")):
                    yield d


def load_all():
    out = {}
    for d in plugin_dirs():
        m = json.load(open(os.path.join(d, "plugin.json"), encoding="utf-8"))
        m["_dir"] = d
        m["_builtin"] = d.startswith(BUILTIN_DIR)
        out[m["id"]] = m  # user plugins override built-ins with the same id
    return out


def get(pid):
    p = load_all().get(pid)
    if not p:
        raise SystemExit(f"unknown plugin {pid}")
    return p


def venv_dir(pid):
    return os.path.join(HOME, "venvs", pid)


def venv_python(pid):
    return os.path.join(venv_dir(pid), "Scripts", "python.exe") if IS_WIN else os.path.join(venv_dir(pid), "bin", "python")


def repo_dir(pid):
    return os.path.join(HOME, "repos", pid)


def manifest_hash(m):
    keys = {k: v for k, v in m.items() if not k.startswith("_")}
    files = b"".join(open(os.path.join(m["_dir"], f), "rb").read() for f in ("adapter.py", "setup.py") if os.path.exists(os.path.join(m["_dir"], f)))
    return hashlib.sha256(json.dumps(keys, sort_keys=True).encode() + files).hexdigest()[:16]


def marker(pid):
    return os.path.join(venv_dir(pid), ".installed")


def is_installed(m):
    f = marker(m["id"])
    return os.path.exists(f) and open(f).read().strip() == manifest_hash(m)


# ---------------------------------------------------------------- config (preferred plugin per kind)
def config_path():
    return os.path.join(HOME, "config.json")


def load_config():
    try:
        return json.load(open(config_path()))
    except Exception:
        return {}


def save_config(c):
    os.makedirs(HOME, exist_ok=True)
    json.dump(c, open(config_path(), "w"), indent=2)


# Measured on 4 CPU cores: Chatterbox ~5x real time, VoxCPM2 ~12x — on CPU Chatterbox goes first.
DEFAULT_ORDER_CPU = {**DEFAULT_ORDER, "tts": ["chatterbox", "voxcpm2"]}


def order_for(kind):
    """Preferred order for a kind: configured list first, then any other installed plugin of that kind."""
    defaults = DEFAULT_ORDER if has_gpu() else DEFAULT_ORDER_CPU
    cfg = load_config().get("order", {}).get(kind) or defaults.get(kind, [])
    plugins = load_all()
    rest = [pid for pid, m in plugins.items() if m["kind"] == kind and pid not in cfg]
    return [pid for pid in [*cfg, *rest] if pid in plugins]


# ---------------------------------------------------------------- install
def uv():
    exe = shutil.which("uv")
    if exe:
        return exe
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--user", "uv"], check=True)
    cand = os.path.join(os.path.expanduser("~"), ".local", "bin", "uv.exe" if IS_WIN else "uv")
    return cand if os.path.exists(cand) else "uv"


def sh(cmd, cwd=None, env=None, timeout=None):
    log("$", " ".join(str(c) for c in cmd)[:220])
    subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, check=True, timeout=timeout)


def plugin_env(m):
    return {
        "PLUGIN_ID": m["id"],
        "PLUGIN_DIR": m["_dir"],
        "PLUGIN_REPO": repo_dir(m["id"]),
        "PLUGIN_DATA": os.path.join(HOME, "data", m["id"]),
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "PYTHONUTF8": "1",
    }


def install(pid, force=False):
    m = get(pid)
    if is_installed(m) and not force:
        log(f"{pid}: already installed")
        return m
    if m.get("gpu") == "required" and not has_gpu():
        log(f"WARNING {pid} needs an NVIDIA GPU (>= {m.get('min_vram_gb', '?')} GB) — install continues but runs will fail on CPU")
    u = uv()
    vd = venv_dir(pid)
    if force and os.path.isdir(vd):
        shutil.rmtree(vd)
    sh([u, "venv", "-q", "--allow-existing", "-p", str(m.get("python", "3.11")), vd])
    py = venv_python(pid)
    env = {"VIRTUAL_ENV": vd}
    tindex = torch_index(m.get("torch_cuda"))
    torch = m.get("torch") or {}
    if torch:
        sh([u, "pip", "install", "-q", "--python", py, "--index-url", tindex, *[f"{k}=={v}" for k, v in torch.items()]], env=env)
    # huggingface_hub first: weights downloads + git-less repo fetching on fresh Windows machines.
    sh([u, "pip", "install", "-q", "--python", py, "huggingface_hub"], env=env)
    if m.get("repo"):
        fetch_repo(m, py)
    reqs = list(m.get("requirements") or [])
    if m.get("repo_requirements") and os.path.exists(os.path.join(repo_dir(pid), m["repo_requirements"])):
        reqs += ["-r", os.path.join(repo_dir(pid), m["repo_requirements"])]
    if reqs:
        links = [x for fl in m.get("find_links", []) for x in ("--find-links", fl)]
        sh([u, "pip", "install", "-q", "--python", py, "--index-strategy", "unsafe-best-match", "--extra-index-url", tindex, *links, *reqs], env=env)
    os.makedirs(plugin_env(m)["PLUGIN_DATA"], exist_ok=True)
    if os.path.exists(os.path.join(m["_dir"], "setup.py")):
        sh([py, os.path.join(m["_dir"], "setup.py")], cwd=m["_dir"], env=plugin_env(m))
    open(marker(pid), "w").write(manifest_hash(m))
    log(f"{pid}: installed")
    return m


def fetch_repo(m, py):
    """git clone when git exists; otherwise GitHub zip / Hugging Face snapshot (no git needed)."""
    rd = repo_dir(m["id"])
    if os.path.isdir(rd) and os.listdir(rd):
        return rd
    os.makedirs(os.path.dirname(rd), exist_ok=True)
    url = m["repo"].rstrip("/").removesuffix(".git")
    if shutil.which("git"):
        sh(["git", "clone", "--depth", "1", *(["--branch", m["repo_ref"]] if m.get("repo_ref") else []), url, rd], env={"GIT_LFS_SKIP_SMUDGE": "1"})
        return rd
    if "huggingface.co/" in url:
        kind = "space" if "/spaces/" in url else "model"
        rid = url.split("huggingface.co/")[1].removeprefix("spaces/")
        sh([py, "-c", f"from huggingface_hub import snapshot_download as s; s({rid!r}, repo_type={kind!r}, local_dir={rd!r}, allow_patterns=['*.py','*.yaml','*.yml','*.json','*.txt','*.mat','*.cfg'])"])
        return rd
    if "github.com/" in url:
        import io
        import urllib.request
        import zipfile
        owner_repo = url.split("github.com/")[1]
        ref = m.get("repo_ref") or "HEAD"
        log(f"git not found — downloading {owner_repo}@{ref} as zip")
        with urllib.request.urlopen(f"https://codeload.github.com/{owner_repo}/zip/{ref}", timeout=300) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
        tmp = rd + ".tmp"
        z.extractall(tmp)
        inner = os.path.join(tmp, os.listdir(tmp)[0])
        shutil.move(inner, rd)
        shutil.rmtree(tmp, ignore_errors=True)
        return rd
    raise RuntimeError(f"cannot fetch {url}: install git")


def uninstall(pid):
    for d in (venv_dir(pid), repo_dir(pid), os.path.join(HOME, "data", pid)):
        shutil.rmtree(d, ignore_errors=True)
    log(f"{pid}: removed")


# ---------------------------------------------------------------- run
def run(pid, args: dict, timeout_min=None):
    m = get(pid)
    if not is_installed(m):
        install(pid)
    cmd = [venv_python(pid), os.path.join(m["_dir"], "adapter.py")]
    for k, v in args.items():
        cmd += [f"--{k.replace('_', '-')}", str(v)]
    t0 = time.time()
    sh(cmd, cwd=m["_dir"], env=plugin_env(m), timeout=60 * (timeout_min or m.get("timeout_min", 60)))
    return time.time() - t0


def run_kind(kind, args: dict, out_key="out"):
    """Try the preferred plugins for a kind in order; first one that produces output wins."""
    errors = []
    for pid in order_for(kind):
        m = get(pid)
        if m.get("gpu") == "required" and not has_gpu():
            errors.append(f"{pid}: skipped (needs GPU)")
            continue
        if not is_installed(m) and os.environ.get("AUTO_INSTALL", "1") != "1":
            errors.append(f"{pid}: not installed")
            continue
        try:
            if os.path.exists(args[out_key]):
                os.remove(args[out_key])
            secs = run(pid, args)
            if os.path.exists(args[out_key]) and os.path.getsize(args[out_key]) > 0:
                return pid, secs
            errors.append(f"{pid}: produced no output")
        except Exception as e:  # try the next plugin
            errors.append(f"{pid}: {type(e).__name__}: {str(e)[:200]}")
            log(f"{pid} failed, trying next:", e)
    raise RuntimeError(f"all {kind} plugins failed: " + " | ".join(errors))


# ---------------------------------------------------------------- user plugins from a GitHub link
def add_user_plugin(manifest: dict, adapter_code: str, setup_code: str | None = None):
    pid = manifest["id"]
    if not pid.replace("-", "").replace("_", "").isalnum():
        raise SystemExit("plugin id must be alphanumeric/dashes")
    if manifest.get("kind") not in KINDS:
        raise SystemExit(f"kind must be one of {KINDS}")
    d = os.path.join(USER_DIR, pid)
    os.makedirs(d, exist_ok=True)
    json.dump(manifest, open(os.path.join(d, "plugin.json"), "w"), indent=2)
    open(os.path.join(d, "adapter.py"), "w", encoding="utf-8").write(adapter_code)
    if setup_code:
        open(os.path.join(d, "setup.py"), "w", encoding="utf-8").write(setup_code)
    return d
