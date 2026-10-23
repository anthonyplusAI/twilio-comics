import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getCameraDestination: vi.fn(),
  reserveCameraBudget: vi.fn(),
  finishCameraBudget: vi.fn(),
  startVoiceVerification: vi.fn(),
  checkVoiceVerification: vi.fn(),
  getOrCreateChannelIdentity: vi.fn(),
  getStagedCameraPhotoCount: vi.fn(),
  stageCameraPhoto: vi.fn(),
  newCameraBlobKey: vi.fn(),
  normalizeCameraImage: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  recordActivityEvent: vi.fn(),
}));

vi.mock("@/lib/browser-photo-access", async (original) => ({
  ...await original(),
  getCameraDestination: h.getCameraDestination,
}));
vi.mock("@/lib/browser-photo-budget", () => ({
  reserveCameraBudget: h.reserveCameraBudget,
  finishCameraBudget: h.finishCameraBudget,
}));
vi.mock("@/lib/voice-verification", () => ({
  startVoiceVerification: h.startVoiceVerification,
  checkVoiceVerification: h.checkVoiceVerification,
}));
vi.mock("@/lib/channel-identities", () => ({ getOrCreateChannelIdentity: h.getOrCreateChannelIdentity }));
vi.mock("@/lib/browser-photo-staging", () => ({
  getStagedCameraPhotoCount: h.getStagedCameraPhotoCount,
  stageCameraPhoto: h.stageCameraPhoto,
  newCameraBlobKey: h.newCameraBlobKey,
}));
vi.mock("@/lib/browser-photo-image", async (original) => ({
  ...await original(),
  normalizeCameraImage: h.normalizeCameraImage,
}));
vi.mock("@/lib/blob-storage", () => ({ uploadBufferToBlob: h.uploadBufferToBlob }));
vi.mock("@/lib/activity-events", () => ({ recordActivityEvent: h.recordActivityEvent }));

import { createPhotoToken, CAMERA_CHALLENGE_COOKIE, CAMERA_SESSION_COOKIE } from "@/lib/browser-photo-session";
import { POST as startVerification } from "@/app/api/voice/photos/verify/start/route";
import { POST as checkVerification } from "@/app/api/voice/photos/verify/check/route";
import { POST as uploadPhoto } from "@/app/api/voice/photos/upload/route";
import { POST as clearPhotoSession } from "@/app/api/voice/photos/session/clear/route";

const ORIGIN = "https://comics.example.com";
const PHONE = "+14155552671";
const OWNER = `twilio_${"a".repeat(32)}`;
const BLOB_KEY = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000001.jpg`;

function jsonRequest(path: string, body: object, cookie?: string, origin = ORIGIN): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function uploadRequest(cookie?: string, origin = ORIGIN): NextRequest {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff])], "selfie.jpg", {
    type: "image/jpeg",
  }));
  form.set("slot", "0");
  return new NextRequest(`${ORIGIN}/api/voice/photos/upload`, {
    method: "POST",
    headers: { origin, ...(cookie ? { cookie } : {}) },
    body: form,
  });
}

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  vi.stubEnv("AUTH_SECRET", "camera-route-test-secret");
  vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
  h.getCameraDestination.mockResolvedValue({
    phoneNumber: "+18669012028",
    smsHref: "sms:+18669012028?body=Turn%20me%20into%20a%20comic!",
    callHref: "tel:+18669012028",
  });
  h.reserveCameraBudget.mockResolvedValue({ allowed: true, eventKey: "camera:verification_start:test" });
  h.finishCameraBudget.mockResolvedValue(undefined);
  h.startVoiceVerification.mockResolvedValue(undefined);
  h.checkVoiceVerification.mockResolvedValue(true);
  h.getOrCreateChannelIdentity.mockResolvedValue({ userId: OWNER });
  h.getStagedCameraPhotoCount.mockResolvedValue(0);
  h.stageCameraPhoto.mockResolvedValue({ count: 1, replaced: false });
  h.newCameraBlobKey.mockReturnValue(BLOB_KEY);
  h.normalizeCameraImage.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  h.uploadBufferToBlob.mockResolvedValue(`${ORIGIN}/api/media?key=unused`);
  h.recordActivityEvent.mockResolvedValue(undefined);
});

describe("verified Voice camera APIs", () => {
  it("clears both shared-booth cookies without exposing a previous attendee", async () => {
    const crossSite = await clearPhotoSession(jsonRequest(
      "/api/voice/photos/session/clear", {}, undefined, "https://evil.example",
    ));
    expect(crossSite.status).toBe(403);

    h.getCameraDestination.mockResolvedValueOnce(null);
    const cleared = await clearPhotoSession(jsonRequest(
      "/api/voice/photos/session/clear", {},
      `${CAMERA_CHALLENGE_COOKIE}=old; ${CAMERA_SESSION_COOKIE}=old`,
    ));
    expect(cleared.status).toBe(200);
    const cookies = cleared.headers.get("set-cookie") || "";
    expect(cookies).toContain(CAMERA_CHALLENGE_COOKIE);
    expect(cookies).toContain(CAMERA_SESSION_COOKIE);
    expect(cookies.match(/Max-Age=0/g)).toHaveLength(2);
    expect(h.getCameraDestination).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests and keeps a disabled camera mode closed", async () => {
    const crossSite = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: PHONE }, undefined, "https://evil.example",
    ));
    expect(crossSite.status).toBe(403);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();

    h.getCameraDestination.mockResolvedValueOnce(null);
    const unavailable = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: PHONE },
    ));
    expect(unavailable.status).toBe(404);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();
  });

  it("bounds code starts and sends Verify only for a valid mobile number", async () => {
    const invalid = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: "not-a-number" },
    ));
    expect(invalid.status).toBe(400);
    expect(h.reserveCameraBudget).not.toHaveBeenCalled();

    h.reserveCameraBudget.mockResolvedValueOnce({ allowed: false, reason: "rate_limit" });
    const limited = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: PHONE },
    ));
    expect(limited.status).toBe(429);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();

    const sent = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: "(415) 555-2671" },
    ));
    expect(sent.status).toBe(200);
    expect(h.startVoiceVerification).toHaveBeenCalledExactlyOnceWith(PHONE);
    expect(sent.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(sent.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect(sent.headers.get("set-cookie")).toMatch(/Secure/);
    expect(sent.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("requires a fresh challenge and an approved code before issuing a phone session", async () => {
    const missing = await checkVerification(jsonRequest(
      "/api/voice/photos/verify/check", { code: "123456" },
    ));
    expect(missing.status).toBe(401);
    expect(h.checkVoiceVerification).not.toHaveBeenCalled();

    const challenge = createPhotoToken(PHONE, "challenge");
    const cookie = `${CAMERA_CHALLENGE_COOKIE}=${challenge}`;
    h.checkVoiceVerification.mockResolvedValueOnce(false);
    const wrong = await checkVerification(jsonRequest(
      "/api/voice/photos/verify/check", { code: "123456" }, cookie,
    ));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const approved = await checkVerification(jsonRequest(
      "/api/voice/photos/verify/check", { code: "654321" }, cookie,
    ));
    expect(approved.status).toBe(200);
    expect(h.checkVoiceVerification).toHaveBeenLastCalledWith(PHONE, "654321");
    expect(approved.headers.get("set-cookie")).toContain(CAMERA_SESSION_COOKIE);
    expect(approved.headers.get("set-cookie")).not.toContain("654321");
  });

  it("rejects uploads without the verified phone cookie and stores only owner-scoped photos", async () => {
    const unauthorized = await uploadPhoto(uploadRequest());
    expect(unauthorized.status).toBe(401);
    expect(h.uploadBufferToBlob).not.toHaveBeenCalled();

    const cookie = `${CAMERA_SESSION_COOKIE}=${createPhotoToken(PHONE, "session")}`;
    const saved = await uploadPhoto(uploadRequest(cookie));
    expect(saved.status).toBe(201);
    expect(h.getOrCreateChannelIdentity).toHaveBeenCalledWith("camera", PHONE);
    expect(h.uploadBufferToBlob).toHaveBeenCalledWith(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]), BLOB_KEY, "image/jpeg",
    );
    expect(h.stageCameraPhoto).toHaveBeenCalledWith(PHONE, OWNER, BLOB_KEY, 0);
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER,
      channel: "camera",
      kind: "camera.photo.stored",
      address: PHONE,
      details: expect.objectContaining({ photoSlot: 1, photoCount: 1 }),
    }));
    const details = h.recordActivityEvent.mock.calls[0][0].details;
    expect(JSON.stringify(details)).not.toContain("123456");
  });

});
