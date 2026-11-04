import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readStudioBudgetToken, readStudioGuestToken } from "@/lib/studio-guest-session";

const h = vi.hoisted(() => ({
  enabled: vi.fn(),
  auth: vi.fn(),
  guestActor: vi.fn(),
  sourceId: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("@/lib/browser-studio-settings", () => ({ getBrowserStudioEnabled: h.enabled }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/studio-guest-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio-guest-session")>()),
  getStudioGuestActor: h.guestActor,
}));
vi.mock("@/lib/studio-guest-budget", () => ({
  getStudioGuestSourceId: h.sourceId,
  issueStudioGuestSession: h.issue,
}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { POST } from "@/app/api/studio/session/route";

function request(origin = "https://comics.example.com") {
  return new NextRequest("https://comics.example.com/api/studio/session", {
    method: "POST",
    headers: { origin },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("AUTH_SECRET", "test-studio-secret");
  h.enabled.mockResolvedValue(true);
  h.auth.mockResolvedValue(null);
  h.guestActor.mockResolvedValue(null);
  h.sourceId.mockReturnValue("a".repeat(32));
  h.issue.mockResolvedValue({ reason: "accepted" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/studio/session", () => {
  it("creates an invisible guest identity with unlimited generation allowance", async () => {
    const response = await POST(request());
    const value = response.cookies.get("twilio_comics_studio_guest")?.value;
    const guestId = readStudioGuestToken(value);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(guestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.issue).toHaveBeenCalledExactlyOnceWith(guestId, "a".repeat(32));
    expect(response.cookies.get("twilio_comics_studio_guest")?.httpOnly).toBe(true);
    expect(readStudioBudgetToken(response.cookies.get("twilio_comics_studio_budget")?.value)).toBe(guestId);
  });

  it("reuses an existing guest instead of creating another user", async () => {
    h.guestActor.mockResolvedValue({ userId: "693a8e78-5b98-49e6-9fc2-4b3352ac387a", kind: "guest" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(readStudioGuestToken(response.cookies.get("twilio_comics_studio_guest")?.value))
      .toBe("693a8e78-5b98-49e6-9fc2-4b3352ac387a");
    expect(h.issue).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a signed-in Google owner without minting a guest cookie (existing cookie: %s)", async (hasGuestCookie) => {
    h.auth.mockResolvedValue({ user: { id: "google-owner", studioAuthorized: true } });
    if (hasGuestCookie) {
      h.guestActor.mockResolvedValue({ userId: "693a8e78-5b98-49e6-9fc2-4b3352ac387a", kind: "guest" });
    }
    const input = request();
    if (hasGuestCookie) input.headers.set("cookie", "twilio_comics_studio_guest=existing");

    const response = await POST(input);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(response.cookies.get("twilio_comics_studio_guest")).toBeUndefined();
    expect(readStudioBudgetToken(response.cookies.get("twilio_comics_studio_budget")?.value))
      .toMatch(/^[0-9a-f-]{36}$/);
    expect(h.guestActor).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.sourceId).not.toHaveBeenCalled();
  });

  it("keeps the same browser budget after a Google owner signs out", async () => {
    h.auth.mockResolvedValueOnce({ user: { id: "google-owner", studioAuthorized: true } })
      .mockResolvedValueOnce(null);
    const signedIn = await POST(request());
    const budgetToken = signedIn.cookies.get("twilio_comics_studio_budget")?.value;
    const budgetId = readStudioBudgetToken(budgetToken);
    const signedOutRequest = request();
    signedOutRequest.headers.set("cookie", `twilio_comics_studio_budget=${budgetToken}`);

    const signedOut = await POST(signedOutRequest);

    expect(signedOut.status).toBe(200);
    expect(readStudioGuestToken(signedOut.cookies.get("twilio_comics_studio_guest")?.value))
      .toMatch(/^[0-9a-f-]{36}$/);
    expect(readStudioBudgetToken(signedOut.cookies.get("twilio_comics_studio_budget")?.value))
      .toBe(budgetId);
  });

  it("does not issue a guest cookie while Browser Studio is closed", async () => {
    h.enabled.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(response.cookies.get("twilio_comics_studio_guest")).toBeUndefined();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it("does not issue a cookie from another origin", async () => {
    const response = await POST(request("https://attacker.example"));

    expect(response.status).toBe(403);
    expect(response.cookies.get("twilio_comics_studio_guest")).toBeUndefined();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it("does not mint another guest when the trusted source has exhausted its budget", async () => {
    h.issue.mockResolvedValue({ reason: "rate_limit" });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.cookies.get("twilio_comics_studio_guest")).toBeUndefined();
  });

  it("fails closed when ACA cannot identify the trusted source", async () => {
    h.sourceId.mockReturnValue(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.cookies.get("twilio_comics_studio_guest")).toBeUndefined();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it("rejects a session POST carrying a body", async () => {
    const input = new NextRequest("https://comics.example.com/api/studio/session", {
      method: "POST",
      headers: { origin: "https://comics.example.com" },
      body: "unexpected",
    });

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(h.issue).not.toHaveBeenCalled();
  });
});
