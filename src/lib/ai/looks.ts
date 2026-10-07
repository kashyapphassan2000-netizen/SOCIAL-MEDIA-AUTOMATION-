import { falAvailable, falRun } from "./fal";
import { download } from "../http";

/**
 * Brand "looks": the same face in a rotating set of outfits / glasses / backdrops, generated from the base photo.
 * Generated once per look and cached, so every video is consistent and the cost is paid once.
 */
export async function generateLook(photoUrl: string, outfitPrompt: string, brandColor: string): Promise<Buffer> {
  if (!falAvailable()) throw new Error("FAL_KEY not set — cannot generate looks");
  const prompt = [
    "Edit this photo of a real person. Keep their face, identity, skin tone, hairstyle, age and facial features EXACTLY the same — photorealistic, not a cartoon.",
    `Change the outfit: ${outfitPrompt}.`,
    `Background: clean modern studio / creator desk, softly blurred, subtle ${brandColor} brand-colour accent light.`,
    "Framing: vertical 9:16 portrait, head and upper chest, centred, eyes looking straight into the camera, mouth closed and relaxed, soft professional key light.",
    "No text, no logos, no watermark, no extra people, hands out of frame.",
  ].join(" ");
  const r = await falRun<{ images: { url: string }[] }>(process.env.FAL_IMAGE_EDIT_MODEL || "fal-ai/nano-banana/edit", {
    prompt,
    image_urls: [photoUrl],
    num_images: 1,
    aspect_ratio: "9:16",
    output_format: "jpeg",
  });
  const url = r.images?.[0]?.url;
  if (!url) throw new Error("image edit returned no image");
  return download(url);
}
