import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A fake ffmpeg that "freezes": it keeps printing the same status line forever, like a deadlocked ffmpeg 7.0.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
const fake = path.join(dir, "ffmpeg");
fs.writeFileSync(fake, `#!/bin/sh\nwhile true; do printf 'frame=   42 fps=3.1 q=28.0 size=  256KiB time=00:00:01.40 bitrate=1.5kbits/s speed=0.1x\\r' >&2; sleep 0.3; done\n`);
fs.chmodSync(fake, 0o755);
process.env.FFMPEG_PATH = fake;

describe("render watchdog", () => {
  it("kills an ffmpeg whose frame counter stops moving even though it keeps printing", async () => {
    const { runFfmpeg } = await import("@/lib/media/ffmpeg");
    const t0 = Date.now();
    await expect(runFfmpeg(["-i", "x", "out.mp4"], 60_000, 1_500)).rejects.toThrow(/stalled/);
    expect(Date.now() - t0).toBeLessThan(20_000); // 3 attempts x ~2-4 s, not the 60 s timeout
  }, 30_000);
});
