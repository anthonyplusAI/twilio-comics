import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStudioTextChallenge,
  readStudioTextChallenge,
  studioTextCookieOptions,
} from "@/lib/studio-comic-text";
import { getStudioTextSourceId } from "@/lib/studio-comic-text-budget";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const STORY_ID = "00000000-0000-4000-8000-000000000002";
const PHONE = "+14155552671";

afterEach(() => vi.unstubAllEnvs());

describe("Studio comic text challenge", () => {
  it("binds a short-lived code challenge to one user, comic, and phone", () => {
    vi.stubEnv("AUTH_SECRET", "studio-text-test-secret");
    const issued = Date.parse("2026-11-03T12:00:00Z");
    const token = createStudioTextChallenge({ userId: USER_ID, storyId: STORY_ID, phone: PHONE }, issued);

    expect(readStudioTextChallenge(token, issued + 1000)).toMatchObject({
      userId: USER_ID,
      storyId: STORY_ID,
      phone: PHONE,
      issued,
    });
    expect(readStudioTextChallenge(token, issued + 10 * 60_000)).toBeNull();
    expect(readStudioTextChallenge(`${token.slice(0, -1)}x`, issued + 1000)).toBeNull();
    expect(token).not.toContain("studio-text-test-secret");
  });

  it("limits the challenge cookie to the SMS endpoints", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
    expect(studioTextCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/api/studio/text-comic",
      maxAge: 600,
    });
  });
});

describe("Studio comic text source budget", () => {
  it("uses ACA's appended source IP rather than a caller-supplied first hop", () => {
    vi.stubEnv("AUTH_SECRET", "studio-text-test-secret");
    vi.stubEnv("CONTAINER_APP_NAME", "twilio-comics");
    const request = (forwarded: string) => new Request("https://comics.example.com/", {
      headers: { "x-forwarded-for": forwarded },
    });
    const genuine = getStudioTextSourceId(request("203.0.113.20, 192.0.2.44"));
    expect(genuine).toMatch(/^[0-9a-f]{32}$/);
    expect(getStudioTextSourceId(request("198.51.100.9, 192.0.2.44"))).toBe(genuine);
    expect(getStudioTextSourceId(request("203.0.113.20, fake-ip"))).toBeNull();
  });
});
