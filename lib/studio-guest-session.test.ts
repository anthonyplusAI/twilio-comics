import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBlobPublicUrl } from "@/lib/blob-storage";
import {
  createStudioBudgetToken,
  createStudioGuestToken,
  getStudioBudgetId,
  getStudioActor,
  getStudioReadActor,
  guestOwnsReferenceImages,
  readStudioGuestToken,
  readStudioBudgetToken,
} from "@/lib/studio-guest-session";

const h = vi.hoisted(() => ({
  enabled: vi.fn(),
  auth: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/browser-studio-settings", () => ({ getBrowserStudioEnabled: h.enabled }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

const GUEST_ID = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
const OTHER_ID = "bbf04d09-50c6-4384-bd75-af935129bc78";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("anonymous Studio guest credentials", () => {
  it("accepts only a signed, unexpired guest token", () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    const issued = Date.parse("2026-11-03T12:00:00Z");
    const token = createStudioGuestToken(GUEST_ID, issued);

    expect(readStudioGuestToken(token, issued + 1000)).toBe(GUEST_ID);
    expect(readStudioGuestToken(`${token.slice(0, -1)}x`, issued + 1000)).toBeNull();
    expect(readStudioGuestToken(token, issued + 30 * 24 * 60 * 60_000)).toBeNull();
    expect(token).not.toContain("test-studio-secret");
  });

  it("keeps one signed budget identity when a guest signs in to Google and out again", () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    const issued = Date.parse("2026-11-03T12:00:00Z");
    const token = createStudioBudgetToken(GUEST_ID, issued);
    const request = new Request("https://comics.example.com/api/generate-comic", {
      headers: { cookie: `twilio_comics_studio_budget=${token}` },
    });

    expect(readStudioBudgetToken(token, issued + 1000)).toBe(GUEST_ID);
    expect(readStudioBudgetToken(`${token.slice(0, -1)}x`, issued + 1000)).toBeNull();
    expect(readStudioBudgetToken(token, issued + 30 * 24 * 60 * 60_000)).toBeNull();
    expect(getStudioBudgetId(request, { userId: GUEST_ID, kind: "guest" })).toBe(GUEST_ID);
    expect(getStudioBudgetId(request, { userId: OTHER_ID, kind: "google" })).toBe(GUEST_ID);
  });

  it("uses the actor identity for direct Google editing without a Studio budget cookie", () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    const request = new Request("https://comics.example.com/api/add-page");

    expect(getStudioBudgetId(request, { userId: OTHER_ID, kind: "google" })).toBe(OTHER_ID);
    const legacyGoogleId = getStudioBudgetId(request, { userId: "legacy-google-owner", kind: "google" });
    expect(legacyGoogleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(getStudioBudgetId(request, { userId: "legacy-google-owner", kind: "google" }))
      .toBe(legacyGoogleId);
  });

  it("keeps an authorized Google owner even when a guest cookie is present", async () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    h.enabled.mockResolvedValue(true);
    h.auth.mockResolvedValue({ user: { id: "google-owner", studioAuthorized: true } });
    h.execute.mockResolvedValue({ rows: [{ id: GUEST_ID }] });
    const cookie = createStudioGuestToken(GUEST_ID);
    const request = new Request("https://comics.example.com/api/stories", {
      headers: { cookie: `twilio_comics_studio_guest=${cookie}` },
    });

    expect(await getStudioActor(request)).toEqual({ userId: "google-owner", kind: "google" });
    expect(h.auth).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("falls back to the existing guest cookie after the Google owner signs out", async () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    h.enabled.mockResolvedValue(true);
    h.auth.mockResolvedValueOnce({ user: { id: "google-owner", studioAuthorized: true } })
      .mockResolvedValueOnce(null);
    h.execute.mockResolvedValue({ rows: [{ id: GUEST_ID }] });
    const cookie = createStudioGuestToken(GUEST_ID);
    const request = new Request("https://comics.example.com/api/stories", {
      headers: { cookie: `twilio_comics_studio_guest=${cookie}` },
    });

    expect(await getStudioActor(request)).toEqual({ userId: "google-owner", kind: "google" });
    expect(await getStudioActor(request)).toEqual({ userId: GUEST_ID, kind: "guest" });
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("uses a guest cookie when a Google account is not authorized for Studio", async () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    h.enabled.mockResolvedValue(true);
    h.auth.mockResolvedValue({ user: { id: "google-viewer", studioAuthorized: false } });
    h.execute.mockResolvedValue({ rows: [{ id: GUEST_ID }] });
    const cookie = createStudioGuestToken(GUEST_ID);
    const request = new Request("https://comics.example.com/api/stories", {
      headers: { cookie: `twilio_comics_studio_guest=${cookie}` },
    });

    expect(await getStudioActor(request)).toEqual({ userId: GUEST_ID, kind: "guest" });
  });

  it("blocks guest and Google access when the admin closes Browser Studio", async () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    h.enabled.mockResolvedValue(false);
    h.auth.mockResolvedValue({ user: { id: "google-owner", studioAuthorized: true } });
    const cookie = createStudioGuestToken(GUEST_ID);
    const request = new Request("https://comics.example.com/api/stories", {
      headers: { cookie: `twilio_comics_studio_guest=${cookie}` },
    });

    expect(await getStudioActor(request)).toBeNull();
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("still identifies a saved guest library when new Studio play is closed", async () => {
    vi.stubEnv("AUTH_SECRET", "test-studio-secret");
    h.enabled.mockResolvedValue(false);
    h.auth.mockResolvedValue(null);
    h.execute.mockResolvedValue({ rows: [{ id: GUEST_ID }] });
    const cookie = createStudioGuestToken(GUEST_ID);
    const request = new Request("https://comics.example.com/api/stories", {
      headers: { cookie: `twilio_comics_studio_guest=${cookie}` },
    });

    expect(await getStudioReadActor(request)).toEqual({ userId: GUEST_ID, kind: "guest" });
    expect(h.enabled).not.toHaveBeenCalled();
  });

  it("still identifies a Google owner's saved library when new Studio play is closed", async () => {
    h.enabled.mockResolvedValue(false);
    h.auth.mockResolvedValue({ user: { id: "google-owner", studioAuthorized: true } });

    expect(await getStudioReadActor(new Request("https://comics.example.com/api/stories")))
      .toEqual({ userId: "google-owner", kind: "google" });
    expect(h.enabled).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("allows a previously approved Google owner without a guest cookie", async () => {
    h.enabled.mockResolvedValue(true);
    h.auth.mockResolvedValue({ user: { id: "google-owner", studioAuthorized: true } });
    const request = new Request("https://comics.example.com/api/stories");

    expect(await getStudioActor(request)).toEqual({ userId: "google-owner", kind: "google" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("accepts only signed uploaded photo URLs belonging to this guest", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
    vi.stubEnv("MEDIA_SIGNING_SECRET", "test-media-secret");
    const own = getBlobPublicUrl(`uploads/${GUEST_ID}/a1111111-1111-4111-8111-111111111111.jpg`);
    const other = getBlobPublicUrl(`uploads/${OTHER_ID}/b2222222-2222-4222-8222-222222222222.jpg`);

    expect(guestOwnsReferenceImages(GUEST_ID, [own])).toBe(true);
    expect(guestOwnsReferenceImages(GUEST_ID, [own, other])).toBe(false);
    expect(guestOwnsReferenceImages(GUEST_ID, [other])).toBe(false);
    expect(guestOwnsReferenceImages(GUEST_ID, [own.replace(/.$/, "x")])).toBe(false);
  });
});
