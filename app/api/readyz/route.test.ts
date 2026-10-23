import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute } }));

import { GET } from "@/app/api/readyz/route";

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ ready: 1 }] });
  for (const key of [
    "DATABASE_URL", "AUTH_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH",
    "AZURE_STORAGE_BLOB_ENDPOINT", "AZURE_STORAGE_QUEUE_ENDPOINT",
    "AZURE_STORAGE_CONTAINER_NAME", "AZURE_STORAGE_QUEUE_NAME", "AZURE_CLIENT_ID",
    "MEDIA_SIGNING_SECRET", "OPENAI_API_KEY", "PUBLIC_BASE_URL",
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
  ]) {
    vi.stubEnv(key, "configured");
  }
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
  vi.stubEnv("RELEASE_SHA", "test-sha");
});

afterEach(() => vi.unstubAllEnvs());

describe("production readiness", () => {
  it("checks channel, admin, and photo settings tables before reporting ready", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ready: true, release: "test-sha" });
    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL).sql;
    expect(query).toContain("public.activity_events");
    expect(query).toContain("public.voice_calls");
    expect(query).toContain("public.admin_login_attempts");
    expect(query).toContain("public.experience_settings");
  });

  it("fails closed before touching the database when a runtime secret is missing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("configuration");
    expect(body).not.toContain("TWILIO_AUTH_TOKEN");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires Voice Verify and Relay settings when Voice is enabled", async () => {
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+18669012028");
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice");
    const response = await GET();

    expect(response.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid canonical public origin", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://comics.example");
    const response = await GET();

    expect(response.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed on a database outage without leaking the connection error", async () => {
    execute.mockRejectedValueOnce(new Error("sensitive database URL"));
    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("database");
    expect(body).not.toContain("sensitive database URL");
  });
});
