import { type NextRequest } from "next/server";
import { recordActivityEvent } from "@/lib/activity-events";
import { uploadBufferToBlob } from "@/lib/blob-storage";
import { getCameraDestination, photoJson } from "@/lib/browser-photo-access";
import { finishCameraBudget, reserveCameraBudget } from "@/lib/browser-photo-budget";
import {
  CameraImageError,
  MAX_CAMERA_FILE_BYTES,
  normalizeCameraImage,
  readCameraPhotoForm,
} from "@/lib/browser-photo-image";
import {
  CAMERA_SESSION_COOKIE,
  photoRequestHasAllowedOrigin,
  readPhotoToken,
} from "@/lib/browser-photo-session";
import { getStagedCameraPhotoCount, newCameraBlobKey, stageCameraPhoto } from "@/lib/browser-photo-staging";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) return photoJson({ error: "Request origin is not allowed" }, 403);
  if (!await getCameraDestination()) return photoJson({ error: "Camera photos are not enabled" }, 404);
  const phone = readPhotoToken(request.cookies.get(CAMERA_SESSION_COOKIE)?.value, "session");
  if (!phone) return photoJson({ error: "Verify your mobile number first" }, 401);

  let form: FormData;
  try {
    form = await readCameraPhotoForm(request);
  } catch (error) {
    return error instanceof CameraImageError
      ? photoJson({ error: error.message }, error.status)
      : photoJson({ error: "Invalid photo upload" }, 400);
  }
  const uploadedFiles = form.getAll("file");
  const file = uploadedFiles.length === 1 ? uploadedFiles[0] : null;
  const slotValue = form.get("slot");
  if (!(file instanceof File) || typeof slotValue !== "string" || !/^[01]$/.test(slotValue)) {
    return photoJson({ error: "Choose a photo slot and image" }, 400);
  }
  if (file.size < 1 || file.size > MAX_CAMERA_FILE_BYTES) {
    return photoJson({ error: "Photo must be 5 MiB or smaller" }, 413);
  }
  const slot = Number(slotValue);
  const identity = await getOrCreateChannelIdentity("camera", phone);
  const currentCount = await getStagedCameraPhotoCount(phone, identity.userId);
  if (slot > currentCount) return photoJson({ error: "Add the first photo before the second" }, 409);

  const budget = await reserveCameraBudget("upload", phone);
  if (!budget.allowed) {
    return photoJson({
      error: budget.reason === "rate_limit"
        ? "Too many photo uploads. Try again later."
        : "Photo upload is unavailable right now.",
    }, budget.reason === "rate_limit" ? 429 : 503);
  }

  let image: Buffer;
  try {
    image = await normalizeCameraImage(file);
  } catch (error) {
    await finishCameraBudget(budget.eventKey, "failed").catch(() => {});
    return error instanceof CameraImageError
      ? photoJson({ error: error.message }, error.status)
      : photoJson({ error: "Could not use that photo" }, 415);
  }

  const blobKey = newCameraBlobKey(identity.userId);
  let staged: Awaited<ReturnType<typeof stageCameraPhoto>>;
  try {
    await uploadBufferToBlob(image, blobKey, "image/jpeg");
    staged = await stageCameraPhoto(phone, identity.userId, blobKey, slot);
  } catch (error) {
    console.error("Browser camera photo could not be staged", error instanceof Error ? error.name : "unknown");
    await finishCameraBudget(budget.eventKey, "failed").catch(() => {});
    return photoJson({ error: "Could not save that photo right now" }, 503);
  }
  if (!staged) {
    await finishCameraBudget(budget.eventKey, "failed").catch(() => {});
    return photoJson({ error: "Photo slots changed. Refresh and try again." }, 409);
  }
  await finishCameraBudget(budget.eventKey, "stored").catch((error) =>
    console.error("Browser camera upload history could not finish", error instanceof Error ? error.name : "unknown"),
  );
  await recordActivityEvent({
    eventKey: `camera:photo:${blobKey.slice(blobKey.lastIndexOf("/") + 1, -4)}`,
    userId: identity.userId,
    channel: "camera",
    kind: "camera.photo.stored",
    direction: "inbound",
    address: phone,
    status: staged.replaced ? "replaced" : "stored",
    details: {
      blobKey,
      photoSlot: slot + 1,
      photoCount: staged.count,
      inputBytes: file.size,
      storedBytes: image.length,
    },
  });
  return photoJson({ ok: true, photoCount: staged.count, slot: slot + 1 }, 201);
}
