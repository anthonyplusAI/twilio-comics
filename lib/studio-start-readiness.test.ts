import { afterEach, describe, expect, it, vi } from "vitest";
import { isStudioStartReady } from "@/lib/studio-start-readiness";

afterEach(() => vi.unstubAllEnvs());

describe("Studio start readiness", () => {
  it("requires Google OAuth credentials and an Auth.js signing secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_SECRET", "secret");
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(isStudioStartReady()).toBe(true);

    vi.stubEnv("AUTH_GOOGLE_SECRET", " ");
    expect(isStudioStartReady()).toBe(false);

    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
    vi.stubEnv("AUTH_SECRET", "");
    expect(isStudioStartReady()).toBe(false);

    vi.stubEnv("AUTH_SECRET", "secret");
    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(isStudioStartReady()).toBe(false);
  });

  it("requires a production tester address", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "secret");
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
    vi.stubEnv("STUDIO_TESTER_EMAILS", " , invalid ");
    expect(isStudioStartReady()).toBe(false);

    vi.stubEnv("STUDIO_TESTER_EMAILS", " , tester@example.com ");
    expect(isStudioStartReady()).toBe(true);

    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example/path");
    expect(isStudioStartReady()).toBe(false);
  });
});
