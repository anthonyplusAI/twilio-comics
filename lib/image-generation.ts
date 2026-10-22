import OpenAI, { toFile } from "openai";
import { isAllowedReferenceUrl } from "@/lib/reference-image-url";

export const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
export const IMAGE_SIZE = "1024x1536"; // portrait 2:3 comic page
export const MAX_REFERENCE_IMAGES = 16;

export interface GenerateComicImageArgs {
  apiKey: string;
  prompt: string;
  referenceImageUrls?: string[];
}

async function urlToFile(url: string, index: number) {
  const parsedUrl = new URL(url);
  if (!isAllowedReferenceUrl(parsedUrl)) {
    throw new Error("Reference image must be a configured Azure Blob or signed media URL");
  }
  const res = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(30_000),
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image ${url}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("Reference image exceeds the 10 MiB limit");
  }
  const contentType = res.headers.get("content-type") || "image/png";
  const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
  return toFile(buffer, `ref-${index}.${ext}`, { type: contentType });
}

export async function generateComicImage({
  apiKey,
  prompt,
  referenceImageUrls = [],
}: GenerateComicImageArgs): Promise<Buffer> {
  const client = new OpenAI({ apiKey });
  const refs = referenceImageUrls.slice(0, MAX_REFERENCE_IMAGES);

  let response;
  if (refs.length === 0) {
    response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt,
      size: IMAGE_SIZE,
      quality: "high",
    });
  } else {
    const images = await Promise.all(refs.map((url, i) => urlToFile(url, i)));
    response = await client.images.edit({
      model: IMAGE_MODEL,
      image: images,
      prompt,
      size: IMAGE_SIZE,
      quality: "high",
    });
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data");
  }
  return Buffer.from(b64, "base64");
}
