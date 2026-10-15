import type { NextConfig } from "next";

// ffmpeg binary + brand font must ship inside the serverless bundle of every
// route that renders video.
const mediaFiles = ["./node_modules/ffmpeg-static/ffmpeg*", "./assets/fonts/**"];

const config: NextConfig = {
  // The Windows Studio app bundles a self-contained server ("Run everything on this PC").
  ...(process.env.NEXT_STANDALONE ? { output: "standalone" as const } : {}),
  serverExternalPackages: ["ffmpeg-static"],
  // Never trace local data (your photo, voice, tokens), build output or tooling into a bundle.
  outputFileTracingExcludes: { "*": [".data/**", "dist/**", "docs/**", "worker/**", "studio/**", "tests/**", "src/**", "*.xlsx"] },
  outputFileTracingIncludes: {
    "/api/cron/tick": mediaFiles,
    "/api/jobs/run": mediaFiles,
    "/api/studio/voice": mediaFiles,
    "/api/health": mediaFiles,
  },
  async headers() {
    return [
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default config;
