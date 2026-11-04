import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ actor: vi.fn(), auth: vi.fn(), story: vi.fn(), deletePage: vi.fn() }));
vi.mock("@/lib/studio-guest-session", () => ({ getStudioActor: h.actor }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db-actions", () => ({
  getStoryWithPagesBySlug: h.story,
  deletePage: h.deletePage,
}));

import { DELETE } from "@/app/api/delete-page/route";

const guestId = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
const pageId = "a1111111-1111-4111-8111-111111111111";

function request(origin = "https://comics.example.com") {
  return new NextRequest("https://comics.example.com/api/delete-page", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ storySlug: "fox-on-mars", pageId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  h.auth.mockResolvedValue(null);
  h.actor.mockResolvedValue({ userId: guestId, kind: "guest" });
  h.story.mockResolvedValue({
    story: { userId: guestId },
    pages: [{ id: pageId }, { id: "b2222222-2222-4222-8222-222222222222" }],
  });
  h.deletePage.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("DELETE /api/delete-page for public Studio", () => {
  it("lets a guest remove a page from their own comic", async () => {
    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(h.deletePage).toHaveBeenCalledWith(pageId);
  });

  it("rejects a guest page deletion from another origin", async () => {
    const response = await DELETE(request("https://attacker.example"));

    expect(response.status).toBe(403);
    expect(h.deletePage).not.toHaveBeenCalled();
  });

  it("rejects another guest's comic", async () => {
    h.story.mockResolvedValue({
      story: { userId: "bbf04d09-50c6-4384-bd75-af935129bc78" },
      pages: [{ id: pageId }, { id: "b2222222-2222-4222-8222-222222222222" }],
    });

    const response = await DELETE(request());

    expect(response.status).toBe(403);
    expect(h.deletePage).not.toHaveBeenCalled();
  });

  it("rejects an oversized deletion body before looking up a story", async () => {
    const input = new NextRequest("https://comics.example.com/api/delete-page", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "https://comics.example.com" },
      body: JSON.stringify({ storySlug: "fox-on-mars", pageId, padding: "x".repeat(17_000) }),
    });

    const response = await DELETE(input);

    expect(response.status).toBe(413);
    expect(h.story).not.toHaveBeenCalled();
    expect(h.deletePage).not.toHaveBeenCalled();
  });
});
