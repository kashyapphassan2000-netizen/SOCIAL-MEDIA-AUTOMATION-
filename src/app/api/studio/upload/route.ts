import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireSession } from "@/lib/auth";
import { handle } from "@/lib/api";

/** Issues short-lived tokens so the browser uploads photo / clip straight to Vercel Blob (bypasses the 4.5MB body limit). */
export const POST = handle(async (req: Request) => {
  const body = (await req.json()) as HandleUploadBody;
  const result = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async () => {
      await requireSession();
      return {
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm", "audio/x-m4a"],
        maximumSizeInBytes: 300 * 1024 * 1024,
        addRandomSuffix: true,
      };
    },
    onUploadCompleted: async () => undefined,
  });
  return NextResponse.json(result);
});
