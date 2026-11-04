import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { uploadBufferToBlob } from "@/lib/blob-storage";
import { reserveBrowserUpload } from "@/lib/browser-upload-budget";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import {
  CameraImageError,
  MAX_CAMERA_REQUEST_BYTES,
  normalizeCameraImage,
  readCameraPhotoForm,
} from "@/lib/browser-photo-image";
import { getStudioActor } from "@/lib/studio-guest-session";
import { reserveStudioGuestUpload } from "@/lib/studio-guest-budget";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const actor = await getStudioActor(request);
  if (!actor) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }
  if (actor.kind === "guest" && !photoRequestHasAllowedOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const userId = actor.userId;

  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected a multipart form upload" },
      { status: 415 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return NextResponse.json({ error: "Invalid Content-Length" }, { status: 400 });
  }
  if (contentLength > MAX_CAMERA_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "Image must be 5 MiB or smaller" },
      { status: 413 },
    );
  }

  if (actor.kind === "guest") {
    const sourceBudget = await reserveStudioGuestUpload(userId, request);
    if (!sourceBudget.allowed) {
      return sourceBudget.reason === "rate_limit"
        ? NextResponse.json({ error: "Upload limit reached. Please try again later." }, { status: 429 })
        : NextResponse.json({ error: "Uploads are temporarily unavailable. Please try again later." }, { status: 503 });
    }
  }

  const uploadBudget = await reserveBrowserUpload(userId);
  if (!uploadBudget.allowed) {
    return uploadBudget.reason === "rate_limit"
      ? NextResponse.json(
          { error: "Upload limit reached. Please try again later." },
          { status: 429 },
        )
      : NextResponse.json(
          { error: "Uploads are temporarily unavailable. Please try again later." },
          { status: 503 },
        );
  }

  let formData: FormData;
  try {
    formData = await readCameraPhotoForm(request);
  } catch (error) {
    return error instanceof CameraImageError
      ? NextResponse.json({ error: error.message }, { status: error.status })
      : NextResponse.json({ error: "Invalid multipart form" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Image file is required" }, { status: 400 });
  }

  let jpeg: Buffer;
  try {
    jpeg = await normalizeCameraImage(file);
  } catch (error) {
    return error instanceof CameraImageError
      ? NextResponse.json({ error: error.message }, { status: error.status })
      : NextResponse.json({ error: "Could not use that photo" }, { status: 415 });
  }

  const key = `uploads/${userId}/${randomUUID()}.jpg`;
  try {
    const url = await uploadBufferToBlob(jpeg, key, "image/jpeg");
    return NextResponse.json({ key, url }, { status: 201 });
  } catch (error) {
    console.error("Blob upload failed", error);
    return NextResponse.json({ error: "Failed to upload image" }, { status: 500 });
  }
}
