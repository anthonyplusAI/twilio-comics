import sharp from "sharp";
import {
  blobExists,
  downloadBlob,
  getBlobPublicUrl,
  uploadBufferToBlob,
} from "@/lib/blob-storage";

// Twilio limits a message's combined media to 5 MB. Leave headroom for
// differences in how transports account for the payload.
const MAX_MMS_PREVIEW_BYTES = 4_500_000;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const compressionSteps = [
  { maxDimension: 2400, quality: 88 },
  { maxDimension: 2200, quality: 80 },
  { maxDimension: 1800, quality: 72 },
  { maxDimension: 1500, quality: 64 },
  { maxDimension: 1200, quality: 55 },
] as const;

/** Create a stable, Twilio-sized JPEG without changing the full-resolution comic. */
export async function createMmsPreview(
  sourceKey: string,
  previewKey: string,
): Promise<string> {
  if (sourceKey === previewKey) {
    throw new Error("The MMS preview key must be different from the comic image key");
  }
  if (await blobExists(previewKey)) return getBlobPublicUrl(previewKey);

  const { buffer } = await downloadBlob(sourceKey);
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new Error("Comic image is too large to prepare for MMS");
  }

  for (const { maxDimension, quality } of compressionSteps) {
    const jpeg = await sharp(buffer, { limitInputPixels: 80_000_000 })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, progressive: true })
      .toBuffer();
    if (jpeg.length > MAX_MMS_PREVIEW_BYTES) continue;

    return uploadBufferToBlob(jpeg, previewKey, "image/jpeg");
  }

  throw new Error("Comic preview still exceeds the Twilio MMS media limit");
}
