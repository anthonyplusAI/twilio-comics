import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ getStoryWithPagesBySlug: vi.fn() }));

vi.mock("@/lib/db-actions", () => ({
  getStoryWithPagesBySlug: h.getStoryWithPagesBySlug,
}));
vi.mock("./channel-comic-viewer", () => ({ ChannelComicViewer: () => null }));
vi.mock("./story-editor-client", () => ({ StoryEditorClient: () => null }));

import StoryPage, { generateMetadata } from "./page";
import { ChannelComicViewer } from "./channel-comic-viewer";
import { StoryEditorClient } from "./story-editor-client";

const params = { params: Promise.resolve({ storySlug: "private-story-slug" }) };

function storyResult(source: string) {
  return {
    story: {
      title: "The Clockwork Hero",
      description: "A hero finds a strange clock.",
      source,
      dubShortUrl: "https://twil.io/comic-private-link",
    },
    pages: [
      {
        pageNumber: 1,
        generatedImageUrl: "https://example.com/page-1.png",
        prompt: "A private user prompt",
        characterImageUrls: ["https://example.com/private-reference.png"],
      },
      { pageNumber: 2, generatedImageUrl: null, prompt: "A private draft" },
    ],
  };
}

describe("story page", () => {
  beforeEach(() => h.getStoryWithPagesBySlug.mockReset());

  it.each(["sms", "voice", "whatsapp"])(
    "uses the public comic viewer for %s and passes only finished images",
    async (source) => {
      h.getStoryWithPagesBySlug.mockResolvedValue(storyResult(source));

      const element = (await StoryPage(params)) as ReactElement<{
        title: string;
        description: string;
        pages: unknown[];
        shareUrl: string;
      }>;

      expect(element.type).toBe(ChannelComicViewer);
      expect(element.props).toEqual({
        title: "The Clockwork Hero",
        description: "A hero finds a strange clock.",
        pages: [{ pageNumber: 1, imageUrl: "https://example.com/page-1.png" }],
        shareUrl: "https://twil.io/comic-private-link",
      });
      expect(JSON.stringify(element.props)).not.toContain("private user prompt");
      expect(JSON.stringify(element.props)).not.toContain("private-reference");
    },
  );

  it("keeps the existing editor for web stories", async () => {
    h.getStoryWithPagesBySlug.mockResolvedValue(storyResult("web"));
    const element = (await StoryPage(params)) as ReactElement;
    expect(element.type).toBe(StoryEditorClient);
  });

  it("keeps phone-channel comics out of search indexing while allowing a share preview", async () => {
    h.getStoryWithPagesBySlug.mockResolvedValue(storyResult("sms"));
    const metadata = await generateMetadata(params);

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.openGraph).toMatchObject({
      title: "The Clockwork Hero | Twilio Comics",
      images: ["https://example.com/page-1.png"],
    });
  });
});
