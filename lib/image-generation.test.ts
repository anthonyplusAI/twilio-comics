import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { generateMock, editMock, toFileMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  editMock: vi.fn(),
  toFileMock: vi.fn(async (buf: Buffer, name: string, opts: any) => ({ name, opts })),
}));

vi.mock("openai", () => {
  function OpenAI() {
    return { images: { generate: generateMock, edit: editMock } };
  }
  return { default: OpenAI, toFile: toFileMock };
});

import { generateComicImage, IMAGE_SIZE } from "@/lib/image-generation";
import { getBlobPublicUrl } from "@/lib/blob-storage";

const B64 = Buffer.from("fake-png-bytes").toString("base64");

beforeEach(() => {
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "https://account.blob.core.windows.net");
  vi.stubEnv("AZURE_STORAGE_CONTAINER_NAME", "comics");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("MEDIA_SIGNING_SECRET", "test-media-signing-secret");
  generateMock.mockReset();
  editMock.mockReset();
  toFileMock.mockClear();
  generateMock.mockResolvedValue({ data: [{ b64_json: B64 }] });
  editMock.mockResolvedValue({ data: [{ b64_json: B64 }] });
  // Stub fetch for reference-image downloads
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("ref").buffer,
    headers: { get: () => "image/png" },
  })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("generateComicImage", () => {
  it("uses images.generate (text-only) when there are no reference images", async () => {
    const out = await generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: [] });
    expect(generateMock).toHaveBeenCalledOnce();
    expect(editMock).not.toHaveBeenCalled();
    const arg = generateMock.mock.calls[0][0];
    expect(arg.model).toBe("gpt-image-2");
    expect(arg.size).toBe("1024x1536");
    expect(arg.size).toBe(IMAGE_SIZE);
    expect(arg.quality).toBe("high");
    expect(arg).not.toHaveProperty("response_format");
    expect(arg).not.toHaveProperty("temperature");
    expect(out).toBeInstanceOf(Buffer);
    expect(out.toString()).toBe("fake-png-bytes");
  });

  it("uses images.edit with a reference image and supported GPT Image 2 arguments", async () => {
    await generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: ["https://account.blob.core.windows.net/comics/a.png"] });
    expect(editMock).toHaveBeenCalledOnce();
    expect(generateMock).not.toHaveBeenCalled();
    const arg = editMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      model: "gpt-image-2",
      prompt: "hero",
      size: IMAGE_SIZE,
      quality: "high",
    });
    expect(Array.isArray(arg.image)).toBe(true);
    expect(arg.image).toHaveLength(1);
    expect(arg.image[0].name).toBe("ref-0.png");
    expect(arg).not.toHaveProperty("input_fidelity");
  });

  it("keeps the previous page ahead of character references for continuation edits", async () => {
    const previousPage = "https://account.blob.core.windows.net/comics/page-1.png";
    const character = "https://account.blob.core.windows.net/comics/hero.png";
    await generateComicImage({
      apiKey: "k",
      prompt: "Next page: the hero reaches the city",
      referenceImageUrls: [previousPage, character],
    });

    const arg = editMock.mock.calls[0][0];
    expect(arg.prompt).toBe("Next page: the hero reaches the city");
    expect(arg.image.map((image: { name: string }) => image.name)).toEqual(["ref-0.png", "ref-1.png"]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([previousPage, character]);
    expect(arg).not.toHaveProperty("input_fidelity");
  });

  it("caps reference images at 16", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://account.blob.core.windows.net/comics/${i}.png`);
    await generateComicImage({ apiKey: "k", prompt: "x", referenceImageUrls: urls });
    expect(editMock.mock.calls[0][0].image).toHaveLength(16);
  });

  it("accepts uploaded reference URLs signed by the public media route", async () => {
    const referenceUrl = getBlobPublicUrl("references/user-1/face.png");
    await generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: [referenceUrl] });
    expect(editMock).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0].toString()).toBe(referenceUrl);
  });

  it("rejects other hosts, containers, and protocol downgrades before fetching", async () => {
    for (const url of [
      "https://example.org/portrait.png",
      "https://account.blob.core.windows.net.evil.example/comics/face.png",
      "https://account.blob.core.windows.net/other-container/face.png",
      "http://account.blob.core.windows.net/comics/face.png",
      "https://comics.example.com/admin/health",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      await expect(generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: [url] }))
        .rejects.toThrow(/reference image/i);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(editMock).not.toHaveBeenCalled();
  });

  it("rejects unsigned and tampered public media URLs before fetching", async () => {
    const signed = getBlobPublicUrl("references/user-1/face.png");
    const tampered = new URL(signed);
    tampered.searchParams.set("key", "references/another-user/face.png");
    for (const url of ["https://comics.example.com/api/media?key=face.png", tampered.toString()]) {
      await expect(generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: [url] }))
        .rejects.toThrow(/reference image/i);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives the allowed Azure Blob origin from a connection string", async () => {
    vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "");
    vi.stubEnv(
      "AZURE_STORAGE_CONNECTION_STRING",
      "DefaultEndpointsProtocol=https;AccountName=account;AccountKey=YQ==;EndpointSuffix=core.windows.net",
    );
    await generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: ["https://account.blob.core.windows.net/comics/face.png"],
    });
    expect(editMock).toHaveBeenCalledOnce();

    await expect(generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: ["https://example.org/portrait.png"],
    })).rejects.toThrow(/reference image/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("supports local Azurite and app-signed media without opening other local paths", async () => {
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true");
    vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "");
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    const signedUpload = getBlobPublicUrl("references/user-1/face.png");
    await generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: [
        "http://127.0.0.1:10000/devstoreaccount1/comics/face.png",
        signedUpload,
      ],
    });
    expect(editMock.mock.calls[0][0].image).toHaveLength(2);

    await expect(generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: ["http://127.0.0.1:10000/another-account/comics/face.png"],
    })).rejects.toThrow(/reference image/i);
    await expect(generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: ["http://localhost:3000/api/private"],
    })).rejects.toThrow(/reference image/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not follow redirects from an allowed reference URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 302 })));
    await expect(generateComicImage({
      apiKey: "k",
      prompt: "hero",
      referenceImageUrls: ["https://account.blob.core.windows.net/comics/face.png"],
    })).rejects.toThrow(/failed to fetch reference image/i);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(editMock).not.toHaveBeenCalled();
  });

  it("throws when OpenAI returns no image data", async () => {
    generateMock.mockResolvedValue({ data: [] });
    await expect(generateComicImage({ apiKey: "k", prompt: "x" })).rejects.toThrow(/no image/i);
  });
});
