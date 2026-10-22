const DEFAULT_LIMITS = {
  maxPages: 24,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
} as const;

type PdfLimits = {
  maxPages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
};

type PdfProgress = { page: number; total: number };

type ComicPdfOptions = {
  title: string;
  imageUrls: string[];
  siteUrl: string;
  onProgress?: (progress: PdfProgress) => void;
  limits?: Partial<PdfLimits>;
};

export function safePdfFilename(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s_-]+|[.\s_-]+$/g, "")
    .replace(/\.pdf$/i, "")
    .slice(0, 80)
    .replace(/[.\s_-]+$/g, "");

  return !name || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)
    ? "comic"
    : name;
}

function imageFormat(bytes: Uint8Array): "PNG" | "JPEG" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "PNG";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "JPEG";
  }
  return null;
}

async function readImage(
  url: string,
  page: number,
  byteLimit: number,
  limitError: string,
): Promise<{ bytes: Uint8Array; format: "PNG" | "JPEG" }> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new Error(`Page ${page} image could not be downloaded by this browser.`);
  }

  if (!response.ok) {
    throw new Error(`Page ${page} image is unavailable (HTTP ${response.status}).`);
  }

  const advertisedLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > byteLimit) {
    throw new Error(limitError);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("This browser cannot safely download the comic images.");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > byteLimit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(limitError);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const format = imageFormat(bytes);
  if (!format) {
    throw new Error(`Page ${page} is not a supported PNG or JPEG image.`);
  }
  return { bytes, format };
}

/** Builds a comic PDF only after a visitor clicks Download PDF in the browser. */
export async function buildComicPdf({
  title,
  imageUrls,
  siteUrl,
  onProgress,
  limits: limitOverrides,
}: ComicPdfOptions): Promise<{ blob: Blob; filename: string }> {
  const limits: PdfLimits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const images = imageUrls.filter((url) => url && url !== "/placeholder.svg");

  if (images.length === 0) {
    throw new Error("This comic has no finished pages to download yet.");
  }
  if (images.length > limits.maxPages) {
    throw new Error(`PDF downloads support up to ${limits.maxPages} pages.`);
  }

  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const site = new URL(siteUrl);
  const credit = `Created by Twilio Comics [${site.host}]`;
  let totalImageBytes = 0;

  for (let index = 0; index < images.length; index++) {
    const page = index + 1;
    onProgress?.({ page, total: images.length });

    const remainingBytes = limits.maxTotalBytes - totalImageBytes;
    if (remainingBytes <= 0) {
      throw new Error("This comic exceeds the total image limit for PDF downloads.");
    }
    const isTotalLimit = remainingBytes < limits.maxImageBytes;
    const { bytes, format } = await readImage(
      images[index],
      page,
      Math.min(limits.maxImageBytes, remainingBytes),
      isTotalLimit
        ? "This comic exceeds the total image limit for PDF downloads."
        : `Page ${page} image exceeds the PDF size limit.`,
    );
    totalImageBytes += bytes.byteLength;

    try {
      const image = pdf.getImageProperties(bytes);
      if (!image.width || !image.height) {
        throw new Error("Invalid image dimensions");
      }
      if (index > 0) pdf.addPage();

      const scale = Math.min(190 / image.width, 262 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      pdf.addImage(bytes, format, (210 - width) / 2, 10 + (262 - height) / 2, width, height);
    } catch {
      throw new Error(`Page ${page} image could not be added to the PDF.`);
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    pdf.text(credit, 105, 290, { align: "center" });
    const creditWidth = pdf.getTextWidth(credit);
    pdf.link(105 - creditWidth / 2, 286, creditWidth, 6, { url: site.origin });
  }

  return {
    blob: new Blob([pdf.output("arraybuffer")], { type: "application/pdf" }),
    filename: `${safePdfFilename(title)}.pdf`,
  };
}
