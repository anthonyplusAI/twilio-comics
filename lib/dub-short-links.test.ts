import { describe, expect, it, vi } from "vitest";
import {
  createOrRecoverDubLink,
  dubConfigFromEnv,
  type DubConfig,
} from "@/lib/dub-short-links";

const config: DubConfig = {
  apiKey: "dub_test_secret",
  domain: "comics.example",
  folderId: "fold_comics",
};
const storyId = "11111111-2222-4333-8444-555555555555";
const key = `comic-${"1".repeat(5)}`;
const url = "https://app.example/story/quiet-moon-a1b2";
const externalId = `twilio-comics-${storyId}`;

function dubLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "clink_123",
    url,
    domain: config.domain,
    key,
    externalId,
    folderId: config.folderId,
    shortLink: `https://${config.domain}/${key}`,
    ...overrides,
  };
}

function json(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Dub comic short links", () => {
  it("creates a branded link in the configured folder with a stable story ID", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(dubLink(), 201));

    const result = await createOrRecoverDubLink({ config, storyId, key, url }, fetcher);

    expect(result).toEqual({ kind: "link", id: "clink_123", key, shortUrl: `https://${config.domain}/${key}` });
    expect(fetcher).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetcher.mock.calls[0];
    expect(requestUrl).toBe("https://api.dub.co/links");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(JSON.parse(init.body)).toEqual({
      url,
      domain: config.domain,
      key,
      externalId,
      folderId: config.folderId,
      doIndex: false,
    });
  });

  it("recovers the same story link after an ambiguous network failure", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(json(dubLink(), 200));

    const result = await createOrRecoverDubLink({ config, storyId, key, url }, fetcher);

    expect(result).toEqual({ kind: "link", id: "clink_123", key, shortUrl: `https://${config.domain}/${key}` });
    expect(fetcher.mock.calls[1][0]).toBe(`https://api.dub.co/links/info?externalId=${encodeURIComponent(externalId)}`);
  });

  it("recovers when an uncertain POST appears only after the first lookups", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce(json({ error: { code: "not_found" } }, 404))
      .mockResolvedValueOnce(json({ error: { code: "not_found" } }, 404))
      .mockResolvedValueOnce(json(dubLink(), 200));

    await expect(createOrRecoverDubLink({ config, storyId, key, url }, fetcher))
      .resolves.toEqual({ kind: "link", id: "clink_123", key, shortUrl: `https://${config.domain}/${key}` });
    expect(fetcher.mock.calls[3][0]).toBe(`https://api.dub.co/links/info?externalId=${encodeURIComponent(externalId)}`);
  });

  it("reports a taken key without adopting another comic's link", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "conflict" } }, 409))
      .mockResolvedValueOnce(json({ error: { code: "not_found" } }, 404))
      .mockResolvedValueOnce(json(dubLink({ externalId: "another-story", url: "https://app.example/story/other" }), 200));

    const result = await createOrRecoverDubLink({ config, storyId, key, url }, fetcher);

    expect(result).toEqual({ kind: "key-conflict" });
    expect(fetcher.mock.calls[2][0]).toBe(`https://api.dub.co/links/info?domain=${config.domain}&key=${key}`);
  });

  it("refuses a successful response outside the requested folder", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(dubLink({ folderId: "fold_other" }), 201));

    await expect(createOrRecoverDubLink({ config, storyId, key, url }, fetcher))
      .rejects.toThrow(/folder/i);
  });

  it("enables shortening only with a complete safe configuration", () => {
    expect(dubConfigFromEnv({})).toBeNull();
    expect(() => dubConfigFromEnv({ DUB_API_KEY: "key", DUB_DOMAIN: "twil.io" }))
      .toThrow(/DUB_FOLDER_ID/);
    expect(dubConfigFromEnv({
      DUB_API_KEY: "key",
      DUB_DOMAIN: "twil.io",
      DUB_FOLDER_ID: "fold_comics",
    })).toEqual({
      apiKey: "key",
      domain: "twil.io",
      folderId: "fold_comics",
    });
    expect(() => dubConfigFromEnv({
      DUB_API_KEY: "key",
      DUB_DOMAIN: "https://twil.io",
      DUB_FOLDER_ID: "fold_comics",
    })).toThrow(/DUB_DOMAIN/);
  });
});
