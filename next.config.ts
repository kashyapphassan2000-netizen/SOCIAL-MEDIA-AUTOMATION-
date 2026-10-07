import type { NextConfig } from "next";

// ffmpeg binary + brand font must ship inside the serverless bundle of every
// route that renders video.
const mediaFiles = ["./node_modules/ffmpeg-static/ffmpeg", "./assets/fonts/**"];

const config: NextConfig = {
  serverExternalPackages: ["ffmpeg-static"],
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
