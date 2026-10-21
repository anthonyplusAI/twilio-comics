import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const h = vi.hoisted(() => ({
  blobExists: vi.fn(),
  downloadBlob: vi.fn(),
  getBlobPublicUrl: vi.fn(),
  uploadBufferToBlob: vi.fn(),
}));

vi.mock("@/lib/blob-storage", () => h);

beforeEach(() => {
  vi.clearAllMocks();
  h.blobExists.mockResolvedValue(false);
  h.uploadBufferToBlob.mockResolvedValue("https://comic.example/api/media?preview");
  h.getBlobPublicUrl.mockReturnValue("https://comic.example/api/media?existing");
});

describe("createMmsPreview", () => {
  it("uploads a resized JPEG preview below the Twilio MMS limit", async () => {
    const source = await sharp({
      create: { width: 3000, height: 1800, channels: 3, background: "#fff" },
    }).png().toBuffer();
    h.downloadBlob.mockResolvedValue({ buffer: source, contentType: "image/png" });
    const { createMmsPreview } = await import("@/lib/mms-preview");

    await expect(
      createMmsPreview("stories/one/page-1.png", "stories/one/page-1-mms.jpg"),
    ).resolves.toBe("https://comic.example/api/media?preview");

    const [jpeg, key, contentType] = h.uploadBufferToBlob.mock.calls[0];
    expect(key).toBe("stories/one/page-1-mms.jpg");
    expect(contentType).toBe("image/jpeg");
    expect(jpeg.length).toBeLessThan(4_500_001);
    const metadata = await sharp(jpeg).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBeLessThanOrEqual(2400);
  });

  it("reuses a preview already present after a job retry", async () => {
    h.blobExists.mockResolvedValue(true);
    const { createMmsPreview } = await import("@/lib/mms-preview");
    await expect(createMmsPreview("source.png", "preview.jpg"))
      .resolves.toBe("https://comic.example/api/media?existing");
    expect(h.downloadBlob).not.toHaveBeenCalled();
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("does not overwrite the original page or upload invalid image bytes", async () => {
    h.downloadBlob.mockResolvedValue({ buffer: Buffer.from("not an image"), contentType: "image/png" });
    const { createMmsPreview } = await import("@/lib/mms-preview");
    await expect(createMmsPreview("same.png", "same.png")).rejects.toThrow(/different/i);
    await expect(createMmsPreview("source.png", "preview.jpg"))
      .rejects.toThrow();
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });
});
