import { afterEach, describe, expect, it, vi } from "vitest";
import { isStudioStartReady } from "@/lib/studio-start-readiness";

afterEach(() => vi.unstubAllEnvs());

function configureBrowserRuntime() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
  vi.stubEnv("AUTH_SECRET", "guest-cookie-secret");
  vi.stubEnv("OPENAI_API_KEY", "server-openai-key");
  vi.stubEnv("MEDIA_SIGNING_SECRET", "media-secret");
  vi.stubEnv("AZURE_STORAGE_CONTAINER_NAME", "comics");
  vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "https://storage.example");
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  vi.stubEnv("AUTH_GOOGLE_ID", "");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "");
  vi.stubEnv("STUDIO_TESTER_EMAILS", "");
}

describe("public Studio start readiness", () => {
  it("does not require Google OAuth or a tester allowlist", () => {
    configureBrowserRuntime();
    expect(isStudioStartReady()).toBe(true);
  });

  it("hides Browser Studio if its server key, media signing, storage, or origin is missing", () => {
    configureBrowserRuntime();
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(isStudioStartReady()).toBe(false);

    configureBrowserRuntime();
    vi.stubEnv("MEDIA_SIGNING_SECRET", "");
    expect(isStudioStartReady()).toBe(false);

    configureBrowserRuntime();
    vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "");
    expect(isStudioStartReady()).toBe(false);

    configureBrowserRuntime();
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example/path");
    expect(isStudioStartReady()).toBe(false);
  });
});
