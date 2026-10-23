import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: h.select, update: h.update } }));

import { comicDeliveryUrl } from "@/lib/dub-short-links";

const storyId = "11111111-2222-4333-8444-555555555555";
const slug = "quiet-moon-a1b2";
const canonicalUrl = `https://comics.example/story/${slug}`;

type StoryLinkRow = {
  slug: string;
  dubKey: string | null;
  dubLinkId: string | null;
  dubShortUrl: string | null;
};

let row: StoryLinkRow;

beforeEach(() => {
  row = { slug, dubKey: null, dubLinkId: null, dubShortUrl: null };
  h.select.mockReset().mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => [{ ...row }] }) }),
  }));
  h.update.mockReset().mockImplementation(() => ({
    set: (updates: Partial<StoryLinkRow>) => ({
      where: () => ({
        returning: async () => {
          Object.assign(row, updates);
          return ["dubShortUrl" in updates
            ? { dubShortUrl: row.dubShortUrl }
            : { dubKey: row.dubKey }];
        },
      }),
    }),
  }));
  vi.stubEnv("DUB_API_KEY", "dub_test_secret");
  vi.stubEnv("DUB_DOMAIN", "twil.io");
  vi.stubEnv("DUB_FOLDER_ID", "fold_comics");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("comic delivery URL persistence", () => {
  it("saves the Dub link before returning it and reuses it on later delivery", async () => {
    const fetcher = vi.fn().mockImplementation(async (_endpoint: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { key: string; externalId: string; url: string };
      return new Response(JSON.stringify({
        id: "clink_123",
        key: request.key,
        domain: "twil.io",
        folderId: "fold_comics",
        externalId: request.externalId,
        url: request.url,
        shortLink: `https://twil.io/${request.key}`,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    const first = await comicDeliveryUrl(storyId, slug, canonicalUrl);
    expect(first).toMatch(/^https:\/\/twil\.io\/comic-[a-z0-9]{19}$/);
    expect(row).toMatchObject({
      dubLinkId: "clink_123",
      dubKey: first.split("/").at(-1),
      dubShortUrl: first,
    });

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(first);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends the branded canonical URL if Dub rejects link creation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(canonicalUrl);
    expect(row.dubKey).toMatch(/^comic-[a-z0-9]{19}$/);
    expect(row.dubShortUrl).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Dub comic link unavailable; sending canonical link",
      expect.objectContaining({ storyId, error: "Dub link creation failed (429)" }),
    );
  });

  it("reports partial configuration instead of silently skipping Dub", async () => {
    vi.stubEnv("DUB_FOLDER_ID", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(canonicalUrl);
    expect(fetcher).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Dub comic link unavailable; sending canonical link",
      expect.objectContaining({ storyId, error: expect.stringContaining("DUB_FOLDER_ID") }),
    );
  });
});
