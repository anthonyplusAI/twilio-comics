import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getStoryWithPagesBySlug: vi.fn(),
  updateStory: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db-actions", () => ({
  getStoryWithPagesBySlug: h.getStoryWithPagesBySlug,
  updateStory: h.updateStory,
}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { GET, PUT } from "@/app/api/stories/[storySlug]/route";

const params = { params: Promise.resolve({ storySlug: "moon-comic" }) };
const noStore = "private, no-store, max-age=0";

function request(method = "GET", body?: string) {
  return new NextRequest("https://comics.example.com/api/stories/moon-comic", {
    method,
    ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(null);
  h.updateStory.mockResolvedValue(undefined);
  h.getStoryWithPagesBySlug.mockResolvedValue({
    story: {
      id: "story-1",
      slug: "moon-comic",
      title: "Moon Comic",
      description: "Private draft notes about a moon adventure",
      style: "classic",
      source: "sms",
      userId: "creator",
      usesOwnApiKey: true,
      createdAt: new Date("2026-10-21T00:00:00Z"),
      updatedAt: new Date("2026-10-21T00:00:00Z"),
    },
    pages: [{
      id: "page-1",
      storyId: "story-1",
      pageNumber: 1,
      prompt: "Make the hero look like my child, named Casey",
      characterImageUrls: ["https://example.com/private-reference.jpg"],
      generatedImageUrl: "https://example.com/comic-page.jpg",
      createdAt: new Date("2026-10-21T00:00:00Z"),
      updatedAt: new Date("2026-10-21T00:00:00Z"),
      privateNotes: "Do not publish this note",
    }],
  });
});

describe("public story JSON cache policy", () => {
  it("does not cache a story or the missing response after it is deleted", async () => {
    const story = await GET(request(), params);
    expect(story.status).toBe(200);
    expect(story.headers.get("cache-control")).toBe(noStore);
    expect(await story.json()).toEqual({
      story: { slug: "moon-comic", title: "Moon Comic", style: "classic" },
      pages: [{ pageNumber: 1, generatedImageUrl: "https://example.com/comic-page.jpg" }],
      isOwner: false,
    });

    h.getStoryWithPagesBySlug.mockResolvedValueOnce(null);
    const missing = await GET(request(), params);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe(noStore);
  });

  it("does not expose private story or page fields to a signed-in non-owner", async () => {
    h.auth.mockResolvedValue({ user: { id: "another-user" } });

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      story: { slug: "moon-comic", title: "Moon Comic", style: "classic" },
      pages: [{ pageNumber: 1, generatedImageUrl: "https://example.com/comic-page.jpg" }],
      isOwner: false,
    });
  });

  it("returns editing fields to the authenticated owner", async () => {
    h.auth.mockResolvedValue({ user: { id: "creator" } });

    const response = await GET(request(), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.isOwner).toBe(true);
    expect(body.pages[0]).toMatchObject({
      id: "page-1",
      prompt: "Make the hero look like my child, named Casey",
      characterImageUrls: ["https://example.com/private-reference.jpg"],
    });
  });

  it("does not cache errors from the story lookup", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.getStoryWithPagesBySlug.mockRejectedValueOnce(new Error("database unavailable"));
      const response = await GET(request(), params);
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe(noStore);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("does not cache an unauthenticated debug-list response", async () => {
    const response = await GET(request(), { params: Promise.resolve({ storySlug: "all" }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe(noStore);
  });

  it("does not cache a story update response", async () => {
    h.auth.mockResolvedValue({ user: { id: "creator" } });
    const response = await PUT(request("PUT", JSON.stringify({ title: "New Moon" })), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(noStore);
    expect(await response.json()).toEqual({ success: true });
  });
});
