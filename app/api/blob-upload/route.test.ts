import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  reserveBrowserUpload: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/blob-storage", () => ({ uploadBufferToBlob: h.uploadBufferToBlob }));
vi.mock("@/lib/browser-upload-budget", () => ({ reserveBrowserUpload: h.reserveBrowserUpload }));

import { POST } from "@/app/api/blob-upload/route";

function uploadRequest(file: File): Request {
  const formData = new FormData();
  formData.set("file", file);
  return new Request("https://comics.example.com/api/blob-upload", {
    method: "POST",
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "owner-1", role: "user", studioAuthorized: true } });
  h.uploadBufferToBlob.mockResolvedValue("https://comics.example.com/photo.jpg");
  h.reserveBrowserUpload.mockResolvedValue({ allowed: true });
});

describe("POST /api/blob-upload", () => {
  it("rejects an oversized multipart stream without Content-Length before uploading", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 64 * 1024 + 1));
        controller.close();
      },
    });
    const request = new Request("https://comics.example.com/api/blob-upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=oversized" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("rejects cumulative multipart bytes despite a smaller declared length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.close();
      },
    });
    const request = new Request("https://comics.example.com/api/blob-upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=oversized",
        "content-length": "8",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("rejects an account over its upload budget before reading the body", async () => {
    h.reserveBrowserUpload.mockResolvedValue({ allowed: false, reason: "rate_limit" });
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://comics.example.com/api/blob-upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(bodyRead).toBe(false);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("fails closed before reading the body when the upload budget is unavailable", async () => {
    h.reserveBrowserUpload.mockResolvedValue({ allowed: false, reason: "unavailable" });
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://comics.example.com/api/blob-upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(bodyRead).toBe(false);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("uploads a valid JPEG after the streamed multipart check", async () => {
    const jpeg = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#4c78a8" },
    }).jpeg().toBuffer();
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array(jpeg)], "photo.jpg", {
      type: "image/jpeg",
    }));
    const request = new Request("https://comics.example.com/api/blob-upload", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ url: "https://comics.example.com/photo.jpg" });
    expect(h.uploadBufferToBlob).toHaveBeenCalledOnce();
  });

  it("stores a WebP portrait as a bounded metadata-free JPEG", async () => {
    const webp = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: "#d0a997" },
    }).webp().toBuffer();

    const response = await POST(uploadRequest(new File([new Uint8Array(webp)], "portrait.webp", {
      type: "image/webp",
    })));

    expect(response.status).toBe(201);
    expect(h.uploadBufferToBlob).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^uploads\/owner-1\/[0-9a-f-]+\.jpg$/),
      "image/jpeg",
    );
    const saved = h.uploadBufferToBlob.mock.calls[0][0] as Buffer;
    const metadata = await sharp(saved).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1600);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects a disguised HEIC upload without storing it", async () => {
    const response = await POST(uploadRequest(new File(
      ["<svg xmlns='http://www.w3.org/2000/svg' />"],
      "portrait.heic",
      { type: "image/heic" },
    )));

    expect(response.status).toBe(415);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["a password admin", { id: "", role: "admin", studioAuthorized: false }],
    ["an unapproved Google account", { id: "google-user", role: "user", studioAuthorized: false }],
    ["a blank Studio identity", { id: "   ", role: "user", studioAuthorized: true }],
  ])("rejects %s before reserving upload budget", async (_label, user) => {
    h.auth.mockResolvedValue({ user });
    const response = await POST(uploadRequest(new File(["photo"], "portrait.jpg", {
      type: "image/jpeg",
    })));

    expect(response.status).toBe(401);
    expect(h.reserveBrowserUpload).not.toHaveBeenCalled();
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();
  });

  it("allows an approved Google admin with a Studio identity", async () => {
    h.auth.mockResolvedValue({ user: {
      id: "google-admin-user", role: "admin", studioAuthorized: true,
    } });
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#4c78a8" },
    }).jpeg().toBuffer();

    const response = await POST(uploadRequest(new File([new Uint8Array(jpeg)], "photo.jpg", {
      type: "image/jpeg",
    })));

    expect(response.status).toBe(201);
    expect(h.reserveBrowserUpload).toHaveBeenCalledWith("google-admin-user");
    expect(h.uploadBufferToBlob).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^uploads\/google-admin-user\/[0-9a-f-]+\.jpg$/),
      "image/jpeg",
    );
  });
});
