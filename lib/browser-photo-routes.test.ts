import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CAMERA_CHALLENGE_COOKIE,
  CAMERA_SESSION_COOKIE,
  createPhotoToken,
} from "@/lib/browser-photo-session";
import { POST as startVerification } from "@/app/api/voice/photos/verify/start/route";
import { POST as checkVerification } from "@/app/api/voice/photos/verify/check/route";
import { POST as uploadPhoto } from "@/app/api/voice/photos/upload/route";
import { POST as clearPhotoSession } from "@/app/api/voice/photos/session/clear/route";

const ORIGIN = "https://comics.example.com";
const PHONE = "+14155552671";

function jsonRequest(path: string, body: object, cookie?: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "camera-route-test-secret");
  vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
});
afterEach(() => vi.unstubAllEnvs());

describe("retired browser photo intake", () => {
  it("rejects a new Verify request before sending a code", async () => {
    const response = await startVerification(jsonRequest(
      "/api/voice/photos/verify/start", { phoneNumber: PHONE },
    ));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/start page/i) });
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a previously issued challenge even with a valid code shape", async () => {
    const challenge = createPhotoToken(PHONE, "challenge");
    const response = await checkVerification(jsonRequest(
      "/api/voice/photos/verify/check", { code: "123456" },
      `${CAMERA_CHALLENGE_COOKIE}=${challenge}`,
    ));
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an upload with an existing verified photo session", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    }));
    form.set("slot", "0");
    const session = createPhotoToken(PHONE, "session");
    const response = await uploadPhoto(new NextRequest(`${ORIGIN}/api/voice/photos/upload`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${CAMERA_SESSION_COOKIE}=${session}` },
      body: form,
    }));
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("still clears old photo-booth cookies", async () => {
    const response = await clearPhotoSession(jsonRequest(
      "/api/voice/photos/session/clear", {},
      `${CAMERA_CHALLENGE_COOKIE}=old; ${CAMERA_SESSION_COOKIE}=old`,
    ));
    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie") || "";
    expect(cookies).toContain(CAMERA_CHALLENGE_COOKIE);
    expect(cookies).toContain(CAMERA_SESSION_COOKIE);
    expect(cookies.match(/Max-Age=0/g)).toHaveLength(2);
  });
});
