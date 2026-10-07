"""Helpers shared by adapters (imported via sys.path; uses the system ffmpeg)."""
import os
import subprocess
import tempfile


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def duration(path):
    r = subprocess.run(["ffmpeg", "-i", path, "-f", "null", "-t", "0", "-"], capture_output=True, text=True)
    import re
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def fit_clip_to_audio(video, audio, out, fps=25, max_src=15, max_w=720):
    """Make a silent clip exactly as long as the audio: ping-pong (forward+reverse) the first
    `max_src` seconds of your real clip so the loop point is invisible, then loop to length."""
    secs = duration(audio) + 0.2
    work = tempfile.mkdtemp(prefix="fit-")
    pp = os.path.join(work, "pp.mp4")
    ff("-i", video, "-t", str(max_src), "-an",
       "-filter_complex", f"[0:v]fps={fps},scale='min({max_w},iw)':-2,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]",
       "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", pp)
    ff("-stream_loop", "-1", "-i", pp, "-t", f"{secs:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", out)
    return out


def mux_audio(video, audio, out):
    ff("-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", out)


def newest(root, ext=".mp4"):
    best, t = None, -1
    for d, _, files in os.walk(root):
        for f in files:
            if f.endswith(ext):
                p = os.path.join(d, f)
                if os.path.getmtime(p) > t:
                    best, t = p, os.path.getmtime(p)
    return best
