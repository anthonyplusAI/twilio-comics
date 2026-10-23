import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CameraImageError,
  MAX_CAMERA_REQUEST_BYTES,
  normalizeCameraImage,
  readCameraPhotoForm,
} from "@/lib/browser-photo-image";

describe("browser photo normalization", () => {
  it("rotates, downsizes, and converts a photo to metadata-free JPEG", async () => {
    const input = await sharp({
      create: { width: 2200, height: 1200, channels: 3, background: "#e7b79c" },
    }).png().withMetadata({ orientation: 6 }).toBuffer();
    const file = new File([new Uint8Array(input)], "selfie.png", { type: "image/png" });
    const result = await normalizeCameraImage(file);
    const metadata = await sharp(result).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(Math.max(metadata.width || 0, metadata.height || 0)).toBeLessThanOrEqual(1600);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects a disguised SVG and oversized input", async () => {
    const svg = new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"] , "x.jpg", {
      type: "image/jpeg",
    });
    await expect(normalizeCameraImage(svg)).rejects.toMatchObject({ status: 415 });

    const huge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg", {
      type: "image/jpeg",
    });
    await expect(normalizeCameraImage(huge)).rejects.toEqual(
      expect.objectContaining({ status: 413, name: "CameraImageError" }),
    );
    expect(new CameraImageError("invalid", 400).message).toBe("invalid");
  });

  it("bounds the multipart stream when Content-Length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CAMERA_REQUEST_BYTES + 1));
        controller.close();
      },
    });
    const request = new Request("https://comics.example.com/api/voice/photos/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readCameraPhotoForm(request)).rejects.toMatchObject({ status: 413 });
  });
});
