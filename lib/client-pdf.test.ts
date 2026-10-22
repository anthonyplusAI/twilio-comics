import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { buildComicPdf, safePdfFilename } from "@/lib/client-pdf";

const siteUrl = "https://comics.example.com";

async function samplePng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 2, height: 3, channels: 4, background: "#e31837" },
    })
      .png()
      .toBuffer(),
  );
}

async function sampleJpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#0263e0" },
    })
      .jpeg()
      .toBuffer(),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("browser comic PDF", () => {
  it("creates a branded two-page PDF from the displayed image URLs", async () => {
    const png = await samplePng();
    const jpeg = await sampleJpeg();
    const requestedUrls: string[] = [];
    const progress: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrls.push(url);
      const image = url.endsWith("one") ? png : jpeg;
      return new Response(new Uint8Array(image).buffer, {
        headers: { "Content-Type": url.endsWith("one") ? "image/png" : "image/jpeg" },
      });
    });

    const result = await buildComicPdf({
      title: "My comic",
      imageUrls: [`${siteUrl}/api/media?key=one`, `${siteUrl}/api/media?key=two`],
      siteUrl,
      onProgress: ({ page, total }) => progress.push(`${page}/${total}`),
    });

    const pdf = Buffer.from(await result.blob.arrayBuffer()).toString("latin1");
    expect(result.filename).toBe("My comic.pdf");
    expect(result.blob.type).toBe("application/pdf");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(2);
    expect(pdf.match(/Created by Twilio Comics/g)).toHaveLength(2);
    expect(pdf).toContain(siteUrl);
    expect(requestedUrls).toEqual([
      `${siteUrl}/api/media?key=one`,
      `${siteUrl}/api/media?key=two`,
    ]);
    expect(progress).toEqual(["1/2", "2/2"]);
  });

  it("rejects comics over the page cap before fetching any images", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      buildComicPdf({
        title: "Long comic",
        imageUrls: Array.from({ length: 25 }, (_, index) => `/image-${index}.png`),
        siteUrl,
      }),
    ).rejects.toThrow(/24 pages/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops reading an image when the streamed bytes exceed its limit", async () => {
    const png = await samplePng();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(png);
              controller.enqueue(new Uint8Array(9));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        ),
    );

    await expect(
      buildComicPdf({
        title: "Large comic",
        imageUrls: ["/image.png"],
        siteUrl,
        limits: { maxImageBytes: png.byteLength + 8 },
      }),
    ).rejects.toThrow(/page 1.*size limit/i);
  });

  it("enforces the total byte cap across pages", async () => {
    const png = await samplePng();
    const jpeg = await sampleJpeg();
    vi.stubGlobal("fetch", async (url: string) => {
      const image = url.endsWith("one") ? png : jpeg;
      return new Response(new Uint8Array(image).buffer, {
        headers: { "Content-Type": url.endsWith("one") ? "image/png" : "image/jpeg" },
      });
    });

    await expect(
      buildComicPdf({
        title: "Large comic",
        imageUrls: ["/one", "/two"],
        siteUrl,
        limits: { maxTotalBytes: png.byteLength + jpeg.byteLength - 1 },
      }),
    ).rejects.toThrow(/total image limit/i);
  });

  it("makes a safe filename from an untrusted story title", () => {
    expect(safePdfFilename("  Rénée / adventures: ✨  ")).toBe("Renee - adventures");
    expect(safePdfFilename("CON")).toBe("comic");
    expect(safePdfFilename("CON.txt")).toBe("comic");
    expect(safePdfFilename("../../")).toBe("comic");
  });
});
