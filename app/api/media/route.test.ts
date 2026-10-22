import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const getProperties = vi.fn();
  const downloadToBuffer = vi.fn();
  const getBlockBlobClient = vi.fn(() => ({ getProperties, downloadToBuffer }));
  const getContainerClient = vi.fn(() => ({ getBlockBlobClient }));
  return {
    getProperties,
    downloadToBuffer,
    getBlockBlobClient,
    fromConnectionString: vi.fn(() => ({ getContainerClient })),
  };
});

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: { fromConnectionString: h.fromConnectionString },
}));

const envNames = [
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_CONTAINER_NAME",
  "PUBLIC_BASE_URL",
  "MEDIA_SIGNING_SECRET",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.getProperties.mockReset();
  h.downloadToBuffer.mockReset();
  process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  process.env.AZURE_STORAGE_CONTAINER_NAME = "comics";
  process.env.PUBLIC_BASE_URL = "https://comics.example.com";
  process.env.MEDIA_SIGNING_SECRET = "media-test-secret";
  h.getProperties.mockResolvedValue({ contentType: "image/jpeg", contentLength: 1234 });
  h.downloadToBuffer.mockResolvedValue(Buffer.from("test image"));
});

afterEach(() => {
  for (const name of envNames) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe("signed media endpoint", () => {
  it("serves signed HEAD metadata without downloading the blob", async () => {
    const { getBlobPublicUrl } = await import("@/lib/blob-storage");
    const { HEAD } = await import("@/app/api/media/route");

    const response = await HEAD(new NextRequest(getBlobPublicUrl("preview/page-1.jpg"), { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe("1234");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("");
    expect(h.getBlockBlobClient).toHaveBeenCalledWith("preview/page-1.jpg");
    expect(h.getProperties).toHaveBeenCalledOnce();
    expect(h.downloadToBuffer).not.toHaveBeenCalled();
  });

  it("rejects unsigned and tampered HEAD URLs without touching storage", async () => {
    const { getBlobPublicUrl } = await import("@/lib/blob-storage");
    const { HEAD } = await import("@/app/api/media/route");
    const signed = new URL(getBlobPublicUrl("preview/page-1.jpg"));
    const tampered = new URL(signed);
    tampered.searchParams.set("key", "preview/other.jpg");

    for (const url of [
      "https://comics.example.com/api/media?key=preview%2Fpage-1.jpg",
      tampered.toString(),
    ]) {
      const response = await HEAD(new NextRequest(url, { method: "HEAD" }));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(await response.text()).toBe("");
    }
    expect(h.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it("returns 404 when a signed blob no longer exists", async () => {
    const { getBlobPublicUrl } = await import("@/lib/blob-storage");
    const { HEAD } = await import("@/app/api/media/route");
    h.getProperties.mockRejectedValueOnce(new Error("BlobNotFound"));

    const response = await HEAD(new NextRequest(getBlobPublicUrl("missing.jpg"), { method: "HEAD" }));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.text()).toBe("");
    expect(h.downloadToBuffer).not.toHaveBeenCalled();
  });

  it("continues to serve GET image bytes", async () => {
    const { getBlobPublicUrl } = await import("@/lib/blob-storage");
    const { GET } = await import("@/app/api/media/route");

    const response = await GET(new NextRequest(getBlobPublicUrl("preview/page-1.jpg")));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("test image"));
    expect(h.downloadToBuffer).toHaveBeenCalledOnce();
  });
});
