import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getFreeTierQuota: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/quota", () => ({ getFreeTierQuota: h.getFreeTierQuota }));

import { POST } from "@/app/api/check-credits/route";

function request(hasApiKey = false): NextRequest {
  return new NextRequest("https://comics.example.com/api/check-credits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hasApiKey }),
  });
}

beforeEach(() => {
  h.auth.mockReset().mockResolvedValue({ user: { id: "player-1" } });
  h.getFreeTierQuota.mockReset();
});

describe("POST /api/check-credits", () => {
  it("requires an authenticated player", async () => {
    h.auth.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(h.getFreeTierQuota).not.toHaveBeenCalled();
  });

  it("returns a player's custom numeric allowance and reset time", async () => {
    const reset = Date.now() + 86_400_000;
    h.getFreeTierQuota.mockResolvedValue({ remaining: 7, reset });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(h.getFreeTierQuota).toHaveBeenCalledWith("player-1");
    expect(await response.json()).toEqual({
      hasApiKey: false,
      creditsRemaining: 7,
      resetTime: reset,
    });
  });

  it("returns unlimited for a player granted an unlimited admin override", async () => {
    h.getFreeTierQuota.mockResolvedValue({ remaining: "unlimited", reset: null });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasApiKey: false,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
  });

  it("returns zero for a player whose generation allowance is paused", async () => {
    h.getFreeTierQuota.mockResolvedValue({ remaining: 0, reset: null });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hasApiKey: false,
      creditsRemaining: 0,
    });
  });

  it("uses a caller-owned API key without querying the app-funded allowance", async () => {
    const response = await POST(request(true));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasApiKey: true,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
    expect(h.getFreeTierQuota).not.toHaveBeenCalled();
  });
});
