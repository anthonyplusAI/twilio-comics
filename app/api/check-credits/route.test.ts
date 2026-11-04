import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ actor: vi.fn(), auth: vi.fn(), quota: vi.fn() }));
vi.mock("@/lib/studio-guest-session", () => ({ getStudioActor: h.actor }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/quota", () => ({ getFreeTierQuota: h.quota }));

import { POST } from "@/app/api/check-credits/route";

function request(body: unknown, origin = "https://comics.example.com") {
  return new NextRequest("https://comics.example.com/api/check-credits", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  h.auth.mockResolvedValue({ user: { id: "player-1" } });
  h.actor.mockImplementation(async () => {
    const userId = (await h.auth())?.user?.id?.trim();
    return userId ? { userId, kind: "google" } : null;
  });
  h.quota.mockResolvedValue({ remaining: "unlimited", reset: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/check-credits for a signed-in owner", () => {
  it("requires an approved Studio identity", async () => {
    h.auth.mockResolvedValue(null);

    const response = await POST(request({ hasApiKey: false }));

    expect(response.status).toBe(401);
    expect(h.quota).not.toHaveBeenCalled();
  });

  it("does not use a Google owner's legacy weekly allowance", async () => {
    const reset = Date.now() + 86_400_000;
    h.quota.mockResolvedValue({ remaining: 7, reset });

    const response = await POST(request({ hasApiKey: false }));

    expect(response.status).toBe(200);
    expect(h.quota).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      hasApiKey: false,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
  });

  it("returns unlimited for an owner granted an unlimited override", async () => {
    const response = await POST(request({ hasApiKey: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasApiKey: false,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
  });

  it("still shows unlimited Studio play when a legacy weekly allowance is zero", async () => {
    h.quota.mockResolvedValue({ remaining: 0, reset: null });

    const response = await POST(request({ hasApiKey: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hasApiKey: false,
      creditsRemaining: "unlimited",
    });
    expect(h.quota).not.toHaveBeenCalled();
  });

  it("uses a signed-in owner's own API key without querying app allowance", async () => {
    const response = await POST(request({ hasApiKey: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasApiKey: true,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
    expect(h.quota).not.toHaveBeenCalled();
  });
});

describe("POST /api/check-credits for public Studio", () => {
  beforeEach(() => {
    h.auth.mockResolvedValue(null);
    h.actor.mockResolvedValue({ userId: "693a8e78-5b98-49e6-9fc2-4b3352ac387a", kind: "guest" });
  });
  it("shows unlimited generations to a guest without a Google account", async () => {
    const response = await POST(request({ hasApiKey: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ creditsRemaining: "unlimited" });
  });

  it("rejects a guest credit check from another origin", async () => {
    const response = await POST(request({ hasApiKey: false }, "https://attacker.example"));

    expect(response.status).toBe(403);
    expect(h.quota).not.toHaveBeenCalled();
  });

  it("does not accept an API-key claim from a guest", async () => {
    const response = await POST(request({ hasApiKey: true }));

    expect(response.status).toBe(400);
    expect(h.quota).not.toHaveBeenCalled();
  });

  it("rejects an oversized JSON body before checking quota", async () => {
    const response = await POST(request({ hasApiKey: false, padding: "x".repeat(17_000) }));

    expect(response.status).toBe(413);
    expect(h.quota).not.toHaveBeenCalled();
  });
});
