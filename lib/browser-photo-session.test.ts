import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPhotoToken,
  normalizePhotoPhone,
  photoRequestHasAllowedOrigin,
  readPhotoToken,
} from "@/lib/browser-photo-session";

afterEach(() => vi.unstubAllEnvs());

describe("browser camera phone verification", () => {
  it("accepts a US mobile number or an explicit international E.164 number", () => {
    expect(normalizePhotoPhone("(415) 555-2671")).toBe("+14155552671");
    expect(normalizePhotoPhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhotoPhone("415-555-2671 ext 9")).toBeNull();
    expect(normalizePhotoPhone("+00012345678")).toBeNull();
  });

  it("signs short-lived, purpose-bound phone tokens without exposing the signing secret", () => {
    vi.stubEnv("AUTH_SECRET", "server-only-camera-secret");
    const now = Date.parse("2026-10-22T12:00:00Z");
    const challenge = createPhotoToken("+14155552671", "challenge", now);
    expect(readPhotoToken(challenge, "challenge", now + 1000)).toBe("+14155552671");
    expect(readPhotoToken(challenge, "session", now + 1000)).toBeNull();
    expect(readPhotoToken(challenge, "challenge", now + 10 * 60_000)).toBeNull();
    expect(readPhotoToken(`${challenge.slice(0, -1)}x`, "challenge", now + 1000)).toBeNull();
    expect(challenge).not.toContain("server-only-camera-secret");

    const session = createPhotoToken("+14155552671", "session", now);
    expect(readPhotoToken(session, "session", now + 14 * 60_000)).toBe("+14155552671");
    expect(readPhotoToken(session, "session", now + 15 * 60_000)).toBeNull();
  });

  it("accepts up to 30 seconds of replica clock skew without extending signed expiry", () => {
    vi.stubEnv("AUTH_SECRET", "server-only-camera-secret");
    const issued = Date.parse("2026-10-22T12:00:00Z");
    const challenge = createPhotoToken("+14155552671", "challenge", issued);

    expect(readPhotoToken(challenge, "challenge", issued - 30_000)).toBe("+14155552671");
    expect(readPhotoToken(challenge, "challenge", issued - 30_001)).toBeNull();
    expect(readPhotoToken(challenge, "challenge", issued + 10 * 60_000 - 1)).toBe("+14155552671");
    expect(readPhotoToken(challenge, "challenge", issued + 10 * 60_000)).toBeNull();
  });

  it("allows only the configured public origin for browser mutations", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
    const request = (origin: string) => new Request("https://comics.example.com/api/voice/photos/upload", {
      method: "POST",
      headers: { origin },
    });
    expect(photoRequestHasAllowedOrigin(request("https://comics.example.com"))).toBe(true);
    expect(photoRequestHasAllowedOrigin(request("https://attacker.example"))).toBe(false);
    expect(photoRequestHasAllowedOrigin(new Request("https://comics.example.com/api/voice/photos/upload", {
      method: "POST",
    }))).toBe(false);
  });
});
