import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { stories } from "@/lib/schema";

const DUB_API = "https://api.dub.co";
const DUB_TIMEOUT_MS = 8_000;
const MAX_KEY_ATTEMPTS = 5;
const UNCERTAIN_POST_RECHECK_MS = [0, 300, 900] as const;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const KEY = /^comic-[a-z0-9]{19}$/;

export interface DubConfig {
  apiKey: string;
  domain: string;
  folderId: string;
}

interface DubLinkInput {
  config: DubConfig;
  storyId: string;
  key: string;
  url: string;
}

type DubLinkResult =
  | { kind: "link"; id: string; key: string; shortUrl: string }
  | { kind: "key-conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function externalIdFor(storyId: string): string {
  return `twilio-comics-${storyId}`;
}

/** Dub is optional, but a partial deployment must be visible to operators. */
export function dubConfigFromEnv(env: Record<string, string | undefined> = process.env): DubConfig | null {
  const apiKey = env.DUB_API_KEY?.trim();
  const domain = env.DUB_DOMAIN?.trim().toLowerCase();
  const folderId = env.DUB_FOLDER_ID?.trim();
  if (!apiKey && !domain && !folderId) return null;
  if (!apiKey || !domain || !folderId) {
    const missing = [
      !apiKey && "DUB_API_KEY",
      !domain && "DUB_DOMAIN",
      !folderId && "DUB_FOLDER_ID",
    ].filter(Boolean);
    throw new Error(`Incomplete Dub configuration: missing ${missing.join(", ")}`);
  }
  if (!DOMAIN.test(domain)) throw new Error("DUB_DOMAIN must be a verified hostname without a scheme or path");
  if (folderId.length > 128 || /\s/.test(folderId)) throw new Error("DUB_FOLDER_ID is invalid");
  return { apiKey, domain, folderId };
}

function parseOwnedLink(value: unknown, input: DubLinkInput): Extract<DubLinkResult, { kind: "link" }> {
  if (!isRecord(value)) throw new Error("Dub returned an invalid link");
  if (value.externalId !== externalIdFor(input.storyId) || value.url !== input.url) {
    throw new Error("Dub returned a link for a different comic");
  }
  if (value.folderId !== input.config.folderId) {
    throw new Error("Dub returned a link outside the configured folder");
  }
  if (value.domain !== input.config.domain || typeof value.key !== "string" || !KEY.test(value.key)) {
    throw new Error("Dub returned a link outside the configured domain or key format");
  }
  if (typeof value.id !== "string" || !value.id || typeof value.shortLink !== "string") {
    throw new Error("Dub returned an incomplete link");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.shortLink);
  } catch {
    throw new Error("Dub returned an invalid short URL");
  }
  if (parsed.protocol !== "https:" || parsed.host !== input.config.domain ||
      parsed.pathname !== `/${value.key}` || parsed.search || parsed.hash ||
      parsed.username || parsed.password) {
    throw new Error("Dub returned an unexpected short URL");
  }
  return { kind: "link", id: value.id, key: value.key, shortUrl: parsed.toString() };
}

async function requestLinkInfo(
  input: DubLinkInput,
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetcher(`${DUB_API}/links/info?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.config.apiKey}` },
      signal: AbortSignal.timeout(DUB_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Dub link lookup failed (network error or timeout)");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Dub link lookup failed (${response.status})`);
  return response.json();
}

/** Recover uncertain POSTs by external ID, then distinguish a taken key from our link. */
export async function createOrRecoverDubLink(
  input: DubLinkInput,
  fetcher: typeof fetch = fetch,
): Promise<DubLinkResult> {
  if (!KEY.test(input.key)) throw new Error("Comic short-link key is invalid");
  const externalId = externalIdFor(input.storyId);
  let postProblem: Error | null = null;
  let response: Response | null = null;
  try {
    response = await fetcher(`${DUB_API}/links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: input.url,
        domain: input.config.domain,
        key: input.key,
        externalId,
        folderId: input.config.folderId,
        doIndex: false,
      }),
      signal: AbortSignal.timeout(DUB_TIMEOUT_MS),
    });
  } catch {
    postProblem = new Error("Dub link creation failed (network error or timeout)");
  }
  if (response?.ok) return parseOwnedLink(await response.json(), input);
  if (response) {
    postProblem = new Error(`Dub link creation failed (${response.status})`);
    if (response.status !== 409 && response.status < 500) throw postProblem;
  }

  // A timed-out POST can finish at Dub just after the first lookup. Give that
  // uncertain commit a short window before falling back to the canonical URL.
  for (const delayMs of UNCERTAIN_POST_RECHECK_MS) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const byExternalId = await requestLinkInfo(
      input,
      new URLSearchParams({ externalId }),
      fetcher,
    );
    if (byExternalId) return parseOwnedLink(byExternalId, input);

    const byKey = await requestLinkInfo(
      input,
      new URLSearchParams({ domain: input.config.domain, key: input.key }),
      fetcher,
    );
    if (byKey) {
      if (!isRecord(byKey) || byKey.domain !== input.config.domain ||
          typeof byKey.key !== "string" || byKey.key.toLowerCase() !== input.key) {
        throw new Error("Dub returned an invalid key lookup");
      }
      if (byKey.externalId === externalId) return parseOwnedLink(byKey, input);
      return { kind: "key-conflict" };
    }
  }
  throw postProblem ?? new Error("Dub did not create or return the comic link");
}

function randomComicKey(): string {
  // Dub keys are case-insensitive. Base36 preserves all 96 random bits while
  // keeping the Voice result text within one GSM SMS segment.
  const value = BigInt(`0x${randomBytes(12).toString("hex")}`);
  return `comic-${value.toString(36).padStart(19, "0")}`;
}

function savedShortUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.toString() : null;
  } catch {
    return null;
  }
}

function uniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

async function currentLinkState(storyId: string) {
  const [row] = await db.select({
    slug: stories.slug,
    dubKey: stories.dubKey,
    dubShortUrl: stories.dubShortUrl,
  }).from(stories).where(eq(stories.id, storyId)).limit(1);
  if (!row) throw new Error("Comic story disappeared before link delivery");
  return row;
}

async function reserveKey(storyId: string, oldKey: string | null): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const candidate = randomComicKey();
    try {
      const [row] = await db.update(stories)
        .set({ dubKey: candidate })
        .where(and(
          eq(stories.id, storyId),
          oldKey === null ? isNull(stories.dubKey) : eq(stories.dubKey, oldKey),
          isNull(stories.dubShortUrl),
        ))
        .returning({ dubKey: stories.dubKey });
      return row?.dubKey ?? null;
    } catch (error) {
      if (!uniqueViolation(error) || attempt === MAX_KEY_ATTEMPTS - 1) throw error;
    }
  }
  return null;
}

/** Create a persistent Dub URL once per story; result SMS stays deliverable if Dub is down. */
export async function comicDeliveryUrl(
  storyId: string,
  storySlug: string,
  canonicalUrl: string,
): Promise<string> {
  try {
    const state = await currentLinkState(storyId);
    if (state.slug !== storySlug) throw new Error("Comic slug changed during delivery");
    if (state.dubShortUrl) {
      const existing = savedShortUrl(state.dubShortUrl);
      if (!existing) throw new Error("Stored comic short URL is invalid");
      return existing;
    }

    const config = dubConfigFromEnv();
    if (!config) return canonicalUrl;

    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
      const latest = await currentLinkState(storyId);
      if (latest.dubShortUrl) {
        const existing = savedShortUrl(latest.dubShortUrl);
        if (!existing) throw new Error("Stored comic short URL is invalid");
        return existing;
      }
      const key = latest.dubKey ?? await reserveKey(storyId, null);
      if (!key) continue; // Another worker reserved a key or completed the link.
      const result = await createOrRecoverDubLink({ config, storyId, key, url: canonicalUrl });
      if (result.kind === "key-conflict") {
        await reserveKey(storyId, key);
        continue;
      }
      const [saved] = await db.update(stories)
        .set({ dubKey: result.key, dubLinkId: result.id, dubShortUrl: result.shortUrl })
        .where(and(eq(stories.id, storyId), eq(stories.dubKey, key), isNull(stories.dubShortUrl)))
        .returning({ dubShortUrl: stories.dubShortUrl });
      if (saved?.dubShortUrl) return saved.dubShortUrl;
      const raced = await currentLinkState(storyId);
      if (raced.dubShortUrl) return savedShortUrl(raced.dubShortUrl) ?? canonicalUrl;
    }
    throw new Error("Unable to reserve a unique comic short-link key");
  } catch (error) {
    console.error("Dub comic link unavailable; sending canonical link", {
      storyId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return canonicalUrl;
  }
}
