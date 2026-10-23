import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn(), randomInt: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomInt: h.randomInt,
}));
vi.mock("@/lib/db", () => ({ db: { select: h.select, update: h.update, insert: h.insert } }));

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
let reservedKeys: Set<string>;

beforeEach(() => {
  row = { slug, dubKey: null, dubLinkId: null, dubShortUrl: null };
  reservedKeys = new Set();
  h.randomInt.mockReset().mockReturnValue(12345);
  h.insert.mockReset().mockImplementation(() => ({
    values: ({ key }: { key: string }) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          if (reservedKeys.has(key)) return [];
          reservedKeys.add(key);
          return [{ key }];
        },
      }),
    }),
  }));
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
    expect(first).toMatch(/^https:\/\/twil\.io\/comic-\d{5}$/);
    expect(row).toMatchObject({
      dubLinkId: "clink_123",
      dubKey: first.split("/").at(-1),
      dubShortUrl: first,
    });
    expect(reservedKeys).toContain(row.dubKey);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(first);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends the branded canonical URL if Dub rejects link creation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(canonicalUrl);
    expect(row.dubKey).toMatch(/^comic-\d{5}$/);
    expect(row.dubShortUrl).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Dub comic link unavailable; sending canonical link",
      expect.objectContaining({ storyId, error: "Dub link creation failed (429)" }),
    );
  });

  it("recovers and persists an issued legacy link before reserving a new key", async () => {
    const legacyKey = `comic-${"a".repeat(19)}`;
    row.dubKey = legacyKey;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "clink_legacy",
      key: legacyKey,
      domain: "twil.io",
      folderId: "fold_comics",
      externalId: `twilio-comics-${storyId}`,
      url: canonicalUrl,
      shortLink: `https://twil.io/${legacyKey}`,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl))
      .toBe(`https://twil.io/${legacyKey}`);
    expect(row).toMatchObject({
      dubKey: legacyKey,
      dubLinkId: "clink_legacy",
      dubShortUrl: `https://twil.io/${legacyKey}`,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(
      `https://api.dub.co/links/info?externalId=${encodeURIComponent(`twilio-comics-${storyId}`)}`,
    );
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("replaces a legacy key with five digits only after Dub confirms it was never issued", async () => {
    row.dubKey = `comic-${"a".repeat(19)}`;
    const fetcher = vi.fn().mockImplementation(async (endpoint: string, init: RequestInit) => {
      if (endpoint.includes("/links/info?")) return new Response("", { status: 404 });
      const request = JSON.parse(String(init.body)) as { key: string; externalId: string; url: string };
      return new Response(JSON.stringify({
        id: "clink_short",
        key: request.key,
        domain: "twil.io",
        folderId: "fold_comics",
        externalId: request.externalId,
        url: request.url,
        shortLink: `https://twil.io/${request.key}`,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl))
      .toMatch(/^https:\/\/twil\.io\/comic-\d{5}$/);
    expect(fetcher.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      expect.stringContaining("/links/info?externalId="),
      "https://api.dub.co/links",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body)).key)
      .toMatch(/^comic-\d{5}$/);
  });

  it("recovers an old Dub link that appears after the first lookup", async () => {
    const legacyKey = `comic-${"a".repeat(19)}`;
    row.dubKey = legacyKey;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "clink_legacy",
        key: legacyKey,
        domain: "twil.io",
        folderId: "fold_comics",
        externalId: `twilio-comics-${storyId}`,
        url: canonicalUrl,
        shortLink: `https://twil.io/${legacyKey}`,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl))
      .toBe(`https://twil.io/${legacyKey}`);
    expect(row).toMatchObject({
      dubKey: legacyKey,
      dubLinkId: "clink_legacy",
      dubShortUrl: `https://twil.io/${legacyKey}`,
    });
    expect(fetcher.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      expect.stringContaining("/links/info?externalId="),
      "https://api.dub.co/links",
      expect.stringContaining("/links/info?externalId="),
    ]);
  });

  it.each([
    ["another story", { externalId: "twilio-comics-another-story" }],
    ["another target", { url: "https://comics.example/story/another" }],
    ["another folder", { folderId: "fold_other" }],
    ["another domain", { domain: "other.example" }],
  ])("rejects a legacy link for %s without replacing its key", async (_case, overrides) => {
    const legacyKey = `comic-${"a".repeat(19)}`;
    row.dubKey = legacyKey;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "clink_legacy",
      key: legacyKey,
      domain: "twil.io",
      folderId: "fold_comics",
      externalId: `twilio-comics-${storyId}`,
      url: canonicalUrl,
      shortLink: `https://twil.io/${legacyKey}`,
      ...overrides,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    expect(await comicDeliveryUrl(storyId, slug, canonicalUrl)).toBe(canonicalUrl);
    expect(row.dubKey).toBe(legacyKey);
    expect(row.dubShortUrl).toBeNull();
    expect(h.insert).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never reuses a five-digit code after its comic is deleted", async () => {
    h.randomInt.mockReset()
      .mockReturnValueOnce(12345)
      .mockReturnValueOnce(12345)
      .mockReturnValueOnce(12346);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_endpoint: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { key: string; externalId: string; url: string };
      return new Response(JSON.stringify({
        id: `clink_${request.key}`,
        key: request.key,
        domain: "twil.io",
        folderId: "fold_comics",
        externalId: request.externalId,
        url: request.url,
        shortLink: `https://twil.io/${request.key}`,
      }), { status: 200 });
    }));

    const first = await comicDeliveryUrl(storyId, slug, canonicalUrl);
    row = { slug, dubKey: null, dubLinkId: null, dubShortUrl: null };
    const second = await comicDeliveryUrl(
      "22222222-3333-4444-8555-666666666666", slug, canonicalUrl,
    );

    expect(first).not.toBe(second);
    expect(reservedKeys).toEqual(new Set([first.split("/").at(-1), second.split("/").at(-1)]));
    expect(h.randomInt).toHaveBeenCalledTimes(3);
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
