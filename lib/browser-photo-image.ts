import sharp from "sharp";

export const MAX_CAMERA_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CAMERA_REQUEST_BYTES = MAX_CAMERA_FILE_BYTES + 64 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/octet-stream",
  "",
]);
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "heif"]);
const MAX_INPUT_PIXELS = 24_000_000;

export class CameraImageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "CameraImageError";
  }
}

/** Bound multipart input even when a client omits Content-Length. */
export async function readCameraPhotoForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new CameraImageError("Expected a photo upload", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_CAMERA_REQUEST_BYTES) {
    throw new CameraImageError("Photo must be 5 MiB or smaller", 413);
  }
  if (!request.body) throw new CameraImageError("Photo upload is empty", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CAMERA_REQUEST_BYTES) {
        await reader.cancel();
        throw new CameraImageError("Photo must be 5 MiB or smaller", 413);
      }
      chunks.push(value);
    }
    return await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch (error) {
    if (error instanceof CameraImageError) throw error;
    throw new CameraImageError("Invalid photo upload", 400);
  } finally {
    reader.releaseLock();
  }
}

/** Re-encode browser camera/gallery input to strip metadata and bound output. */
export async function normalizeCameraImage(file: File): Promise<Buffer> {
  if (file.size < 1) throw new CameraImageError("Choose a photo first", 400);
  if (file.size > MAX_CAMERA_FILE_BYTES) {
    throw new CameraImageError("Photo must be 5 MiB or smaller", 413);
  }
  if (!ALLOWED_MIME.has(file.type.toLowerCase())) {
    throw new CameraImageError("Choose a JPEG, PNG, WebP, or HEIC photo", 415);
  }

  let input: Buffer;
  try {
    input = Buffer.from(await file.arrayBuffer());
  } catch {
    throw new CameraImageError("Could not read that photo", 400);
  }

  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format) ||
        !metadata.width || !metadata.height ||
        metadata.width * metadata.height > MAX_INPUT_PIXELS ||
        (metadata.pages ?? 1) !== 1) {
      throw new CameraImageError("Choose one JPEG, PNG, WebP, or HEIC photo", 415);
    }

    return await image.rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch (error) {
    if (error instanceof CameraImageError) throw error;
    throw new CameraImageError("Could not use that photo. Try a JPEG or PNG image.", 415);
  }
}
