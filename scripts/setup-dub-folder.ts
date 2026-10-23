import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "../envConfig";

const FOLDER_NAME = "Twilio Comics";
const FOLDERS_ENDPOINT = "https://api.dub.co/folders";
const PAGE_SIZE = 50;
const MAX_PAGES = 1_000;

type DubFolder = {
  id: string;
  name: string;
  accessLevel?: string | null;
};

function folderFromJson(value: unknown): DubFolder {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as DubFolder).id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test((value as DubFolder).id) ||
    typeof (value as DubFolder).name !== "string"
  ) {
    throw new Error("Dub API returned an invalid folder.");
  }
  return value as DubFolder;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Dub API returned invalid JSON.");
  }
}

function apiError(method: "GET" | "POST", status: number): Error {
  const action = method === "GET" ? "list" : "create";
  if (status === 401 || status === 403) {
    return new Error(
      `Dub API ${method} /folders returned ${status}. Check DUB_API_KEY and workspace permissions.`,
    );
  }
  if (status === 429) {
    return new Error("Dub API rate limit reached. Retry folder setup shortly.");
  }
  return new Error(`Dub API could not ${action} folders (HTTP ${status}).`);
}

async function request(
  method: "GET" | "POST",
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  body?: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Network errors and API response bodies are intentionally not logged: either
    // can contain credential-bearing request details.
    throw new Error("Could not reach Dub API. Retry folder setup shortly.");
  }
}

async function findExistingFolderId(apiKey: string, fetchImpl: typeof fetch): Promise<string | null> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(FOLDERS_ENDPOINT);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    const response = await request("GET", url.toString(), apiKey, fetchImpl);
    if (!response.ok) throw apiError("GET", response.status);

    const data = await parseJson(response);
    if (!Array.isArray(data)) throw new Error("Dub API returned an invalid folder list.");
    const folders = data.map(folderFromJson);
    const existing = folders.find((folder) => folder.name === FOLDER_NAME);
    if (existing) {
      if (existing.accessLevel === "read" || existing.accessLevel === null) {
        throw new Error("The existing Twilio Comics folder does not allow link creation.");
      }
      return existing.id;
    }
    if (folders.length < PAGE_SIZE) return null;
  }
  throw new Error("Dub has too many folder pages to scan safely; no folder was created.");
}

/**
 * Finds or creates the one folder used by comic links. Safe to rerun after a
 * failed response: a later run lists the folder before attempting creation.
 */
export async function ensureDubFolderId(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!apiKey.trim()) throw new Error("DUB_API_KEY is required.");
  const existingId = await findExistingFolderId(apiKey.trim(), fetchImpl);
  if (existingId) return existingId;

  const response = await request(
    "POST",
    FOLDERS_ENDPOINT,
    apiKey.trim(),
    fetchImpl,
    JSON.stringify({ name: FOLDER_NAME }),
  );
  if (response.status === 409) {
    const racedId = await findExistingFolderId(apiKey.trim(), fetchImpl);
    if (racedId) return racedId;
    throw new Error("Dub reported a folder conflict; retry setup shortly.");
  }
  if (!response.ok) throw apiError("POST", response.status);

  const created = folderFromJson(await parseJson(response));
  if (created.name !== FOLDER_NAME) {
    throw new Error("Dub API returned a different folder after creation.");
  }
  return created.id;
}

async function main(): Promise<void> {
  try {
    const folderId = await ensureDubFolderId(process.env.DUB_API_KEY ?? "");
    process.stdout.write(`DUB_FOLDER_ID=${folderId}\n`);
    process.stdout.write("Set DUB_FOLDER_ID to this value in the app configuration.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Dub folder setup failed."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
