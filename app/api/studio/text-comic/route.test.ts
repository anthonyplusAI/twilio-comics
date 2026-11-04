import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getStudioComicTextOrigin: vi.fn(),
  getStudioActor: vi.fn(),
  getStoryWithPagesBySlug: vi.fn(),
  getStudioTextSourceId: vi.fn(),
  reserveStudioTextBudget: vi.fn(),
  finishStudioTextBudget: vi.fn(),
  startVoiceVerification: vi.fn(),
  checkVoiceVerification: vi.fn(),
  sendSms: vi.fn(),
  comicDeliveryUrl: vi.fn(),
}));

vi.mock("@/lib/studio-comic-text", async (original) => ({
  ...await original(),
  getStudioComicTextOrigin: h.getStudioComicTextOrigin,
}));
vi.mock("@/lib/studio-guest-session", () => ({ getStudioActor: h.getStudioActor }));
vi.mock("@/lib/db-actions", () => ({ getStoryWithPagesBySlug: h.getStoryWithPagesBySlug }));
vi.mock("@/lib/studio-comic-text-budget", () => ({
  getStudioTextSourceId: h.getStudioTextSourceId,
  reserveStudioTextBudget: h.reserveStudioTextBudget,
  finishStudioTextBudget: h.finishStudioTextBudget,
}));
vi.mock("@/lib/voice-verification", () => ({
  startVoiceVerification: h.startVoiceVerification,
  checkVoiceVerification: h.checkVoiceVerification,
}));
vi.mock("@/lib/twilio", () => ({ sendSms: h.sendSms }));
vi.mock("@/lib/dub-short-links", () => ({ comicDeliveryUrl: h.comicDeliveryUrl }));

import { createStudioTextChallenge, STUDIO_TEXT_CHALLENGE_COOKIE } from "@/lib/studio-comic-text";
import { POST as start } from "@/app/api/studio/text-comic/start/route";
import { POST as confirm } from "@/app/api/studio/text-comic/confirm/route";

const ORIGIN = "https://comics.example.com";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const STORY_ID = "00000000-0000-4000-8000-000000000002";
const PHONE = "+14155552671";
const SLUG = "hero-noir-0123456789abcdef0123456789abcdef";

function request(path: string, body: object, cookie?: string, origin = ORIGIN): NextRequest {
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

function challengeCookie(userId = USER_ID, storyId = STORY_ID, phone = PHONE) {
  return `${STUDIO_TEXT_CHALLENGE_COOKIE}=${createStudioTextChallenge({ userId, storyId, phone })}`;
}

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  vi.stubEnv("AUTH_SECRET", "studio-text-route-test-secret");
  vi.stubEnv("PUBLIC_BASE_URL", ORIGIN);
  h.getStudioComicTextOrigin.mockResolvedValue(ORIGIN);
  h.getStudioActor.mockResolvedValue({ userId: USER_ID, kind: "guest" });
  h.getStoryWithPagesBySlug.mockResolvedValue({
    story: { id: STORY_ID, slug: SLUG, userId: USER_ID, source: "web" },
    pages: [{ generatedImageUrl: "https://images.example.com/comic.jpg" }],
  });
  h.getStudioTextSourceId.mockReturnValue("a".repeat(32));
  h.reserveStudioTextBudget.mockResolvedValue({ allowed: true, eventKey: "studio-text:test" });
  h.finishStudioTextBudget.mockResolvedValue(undefined);
  h.startVoiceVerification.mockResolvedValue(undefined);
  h.checkVoiceVerification.mockResolvedValue(true);
  h.sendSms.mockResolvedValue(`SM${"b".repeat(32)}`);
  h.comicDeliveryUrl.mockResolvedValue("https://twil.io/comic-12345");
});

afterEach(() => vi.unstubAllEnvs());

describe("optional browser comic SMS", () => {
  it("rejects cross-origin and disabled requests before any Verify SMS", async () => {
    const crossSite = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: PHONE,
    }, undefined, "https://attacker.example"));
    expect(crossSite.status).toBe(403);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();

    h.getStudioComicTextOrigin.mockResolvedValueOnce(null);
    const disabled = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: PHONE,
    }));
    expect(disabled.status).toBe(404);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();
  });

  it("requires an owned, finished browser comic and a rate-limit reservation", async () => {
    h.getStoryWithPagesBySlug.mockResolvedValueOnce({
      story: { id: STORY_ID, slug: SLUG, userId: "another-user", source: "web" },
      pages: [{ generatedImageUrl: "https://images.example.com/comic.jpg" }],
    });
    const notOwner = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: PHONE,
    }));
    expect(notOwner.status).toBe(404);

    h.getStoryWithPagesBySlug.mockResolvedValueOnce({
      story: { id: STORY_ID, slug: SLUG, userId: USER_ID, source: "web" },
      pages: [{ generatedImageUrl: null }],
    });
    const unfinished = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: PHONE,
    }));
    expect(unfinished.status).toBe(409);

    h.reserveStudioTextBudget.mockResolvedValueOnce({ allowed: false, reason: "rate_limit" });
    const limited = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: PHONE,
    }));
    expect(limited.status).toBe(429);
    expect(h.startVoiceVerification).not.toHaveBeenCalled();
  });

  it("sends a code and a signed challenge for the owner's phone", async () => {
    const response = await start(request("/api/studio/text-comic/start", {
      storySlug: SLUG, phoneNumber: "(415) 555-2671",
    }));
    expect(response.status).toBe(200);
    expect(h.startVoiceVerification).toHaveBeenCalledExactlyOnceWith(PHONE);
    expect(response.headers.get("set-cookie")).toContain(STUDIO_TEXT_CHALLENGE_COOKIE);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("never texts a link without a code bound to the same owner and story", async () => {
    const missing = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }));
    expect(missing.status).toBe(401);

    const otherActor = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }, challengeCookie("another-user")));
    expect(otherActor.status).toBe(401);

    const otherStory = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }, challengeCookie(USER_ID, "00000000-0000-4000-8000-000000000099")));
    expect(otherStory.status).toBe(404);
    expect(h.checkVoiceVerification).not.toHaveBeenCalled();
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("checks the code, then sends only the verified phone a short comic link", async () => {
    const cookie = challengeCookie();
    h.checkVoiceVerification.mockResolvedValueOnce(false);
    const wrong = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }, cookie));
    expect(wrong.status).toBe(401);
    expect(h.sendSms).not.toHaveBeenCalled();

    const approved = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "654321", phoneNumber: "+19995550000",
    }, cookie));
    expect(approved.status).toBe(200);
    expect(h.checkVoiceVerification).toHaveBeenLastCalledWith(PHONE, "654321");
    expect(h.comicDeliveryUrl).toHaveBeenCalledExactlyOnceWith(
      STORY_ID,
      SLUG,
      `${ORIGIN}/story/${SLUG}`,
    );
    expect(h.sendSms).toHaveBeenCalledExactlyOnceWith({
      to: PHONE,
      body: "Your Twilio Comics comic is ready: https://twil.io/comic-12345",
    });
    expect(approved.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("does not send if the link budget denies after Verify approval", async () => {
    h.reserveStudioTextBudget
      .mockResolvedValueOnce({ allowed: true, eventKey: "studio-text:check" })
      .mockResolvedValueOnce({ allowed: false, reason: "rate_limit" });
    const response = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }, challengeCookie()));
    expect(response.status).toBe(429);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("asks for a new code when Verify reports an expired challenge", async () => {
    h.checkVoiceVerification.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    const response = await confirm(request("/api/studio/text-comic/confirm", {
      storySlug: SLUG, code: "123456",
    }, challengeCookie()));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(h.sendSms).not.toHaveBeenCalled();
  });
});
