import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { uploadBufferToBlob } from "@/lib/blob-storage";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectImageType(bytes: Uint8Array) {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return { contentType: "image/png", extension: "png" } as const;
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { contentType: "image/jpeg", extension: "jpg" } as const;
  }
  return null;
}

export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected a multipart form upload" },
      { status: 415 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_FILE_SIZE + 64 * 1024) {
    return NextResponse.json(
      { error: "Image must be 5 MiB or smaller" },
      { status: 413 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Image file is required" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Image must be 5 MiB or smaller" },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const imageType = detectImageType(buffer);
  if (!imageType) {
    return NextResponse.json(
      { error: "Only PNG and JPEG images are supported" },
      { status: 415 },
    );
  }
  if (file.type && file.type !== imageType.contentType) {
    return NextResponse.json(
      { error: "Image content does not match its declared type" },
      { status: 415 },
    );
  }

  const key = `uploads/${userId}/${randomUUID()}.${imageType.extension}`;
  try {
    const url = await uploadBufferToBlob(buffer, key, imageType.contentType);
    return NextResponse.json({ key, url }, { status: 201 });
  } catch (error) {
    console.error("Blob upload failed", error);
    return NextResponse.json({ error: "Failed to upload image" }, { status: 500 });
  }
}
