import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

import { channelStoryLink, latestStoryLinkForSms } from "@/lib/channel-story-link";

const dialect = new PgDialect();
const storyId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";

beforeEach(() => {
  h.execute.mockReset();
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
});

afterEach(() => vi.unstubAllEnvs());

describe("channel story link", () => {
  it("looks up the story through the exact SMS sender identity", async () => {
    h.execute.mockResolvedValue({ rows: [{ slug: "robot-detective" }] });

    await expect(channelStoryLink({
      storyId,
      channel: "sms",
      address: "+15551112222",
    })).resolves.toBe("https://comics.example.com/story/robot-detective");

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/JOIN channel_identities AS identity ON identity.user_id = story.user_id/);
    expect(query.sql).toMatch(/story\.id = \$1::uuid/);
    expect(query.sql).toMatch(/identity\.provider = 'twilio'/);
    expect(query.sql).toMatch(/identity\.channel = \$2/);
    expect(query.sql).toMatch(/identity\.address = \$3/);
    expect(query.sql).toMatch(/identity\.normalized_address = \$4/);
    expect(query.params).toEqual([storyId, "sms", "+15551112222", "+15551112222"]);
  });

  it("uses the same WhatsApp sender and channel rather than an SMS identity", async () => {
    h.execute.mockResolvedValue([{ slug: "whatsapp-story" }]);

    await expect(channelStoryLink({
      storyId,
      channel: "whatsapp",
      address: "whatsapp:+15551112222",
    })).resolves.toBe("https://comics.example.com/story/whatsapp-story");

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.params).toEqual([
      storyId, "whatsapp", "whatsapp:+15551112222", "+15551112222",
    ]);
  });

  it("returns no link for a missing story or unsafe slug", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slug: "../other-user" }] });

    await expect(channelStoryLink({ storyId, channel: "sms", address: "+15551112222" }))
      .resolves.toBeNull();
    await expect(channelStoryLink({ storyId, channel: "sms", address: "+15551112222" }))
      .resolves.toBeNull();
  });

  it("rejects malformed or cross-channel sender addresses before querying", async () => {
    await expect(channelStoryLink({ storyId, channel: "sms", address: "whatsapp:+15551112222" }))
      .resolves.toBeNull();
    await expect(channelStoryLink({ storyId, channel: "whatsapp", address: "+15551112222" }))
      .resolves.toBeNull();
    await expect(channelStoryLink({ storyId: "other", channel: "sms", address: "+15551112222" }))
      .resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not construct a link from an absent or unsafe public base URL", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://untrusted.example.com");
    await expect(channelStoryLink({ storyId, channel: "sms", address: "+15551112222" }))
      .resolves.toBeNull();
    vi.stubEnv("PUBLIC_BASE_URL", "");
    await expect(channelStoryLink({ storyId, channel: "sms", address: "+15551112222" }))
      .resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("retries unexpected storage failure instead of claiming the story is gone", async () => {
    h.execute.mockRejectedValue(new Error("PostgreSQL unavailable"));
    await expect(channelStoryLink({ storyId, channel: "sms", address: "+15551112222" }))
      .rejects.toThrow("PostgreSQL unavailable");
  });

  it("finds the newest owned active comic, allowing recent Voice recovery", async () => {
    h.execute.mockResolvedValue({ rows: [{
      story_id: storyId,
      slug: "phone-call-hero",
      source: "voice",
    }] });

    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "+15553334444",
    })).resolves.toEqual({
      storyId,
      source: "voice",
      link: "https://comics.example.com/story/phone-call-hero",
    });

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/story\.id = job\.story_id AND story\.user_id = job\.user_id/);
    expect(query.sql).toMatch(/sms_identity\.user_id = job\.user_id/);
    expect(query.sql).toMatch(/sms_identity\.provider = 'twilio'/);
    expect(query.sql).toMatch(/sms_identity\.channel = 'sms'/);
    expect(query.sql).toMatch(/sms_identity\.address = \$1/);
    expect(query.sql).toMatch(/sms_identity\.normalized_address = \$2/);
    expect(query.sql).toMatch(/source_identity\.user_id = job\.user_id/);
    expect(query.sql).toMatch(/source_identity\.provider = 'twilio'/);
    expect(query.sql).toMatch(/source_identity\.channel = job\.source/);
    expect(query.sql).toMatch(/source_identity\.address = \$3/);
    expect(query.sql).toMatch(/source_identity\.normalized_address = \$4/);
    expect(query.sql).toMatch(/JOIN conversations AS source_conversation\s+ON source_conversation\.channel = job\.source\s+AND source_conversation\.phone_number = sms_identity\.address\s+AND source_conversation\.state = 'done'\s+AND source_conversation\.active_story_id = story\.id/s);
    expect(query.sql).toMatch(/job\.source IN \('sms', 'voice'\)/);
    expect(query.sql).toMatch(/job\.recipient_address = \$5/);
    expect(query.sql).toMatch(/job\.sender_address = \$6/);
    expect(query.sql).toMatch(/job\.completed_at IS NOT NULL/);
    expect(query.sql).toMatch(/job\.source <> 'voice' OR \(\s*job\.created_at >= NOW\(\) - INTERVAL '24 hours'\s+AND job\.completed_at >= NOW\(\) - INTERVAL '24 hours'\s*\)/s);
    expect(query.sql).toMatch(
      /job\.completed_at >= NOW\(\) - \(\$7 \* INTERVAL '1 day'\)/,
    );
    expect(query.sql).toMatch(/job\.status = 'failed'/);
    expect(query.sql).toMatch(/ORDER BY job\.completed_at DESC NULLS LAST.*LIMIT 1/s);
    expect(query.params).toEqual([
      "+15551112222", "+15551112222", "+15551112222",
      "+15551112222", "+15551112222", "+15553334444", 14,
    ]);
  });

  it("returns no old Voice link after the source conversation is reset", async () => {
    // PostgreSQL excludes rows without a matching active source conversation.
    h.execute.mockResolvedValue({ rows: [] });

    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "+15553334444",
    })).resolves.toBeNull();

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("source_conversation.active_story_id = story.id");
    expect(query.sql).toContain("job.created_at >= NOW() - INTERVAL '24 hours'");
  });

  it("recovers a saved comic after any terminal delivery failure when this job has an image", async () => {
    h.execute.mockResolvedValue({ rows: [{
      story_id: storyId,
      slug: "delivery-failed-comic",
      source: "sms",
    }] });

    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "+15553334444",
    })).resolves.toEqual({
      storyId,
      source: "sms",
      link: "https://comics.example.com/story/delivery-failed-comic",
    });

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/job\.status = 'failed' AND EXISTS \(\s*SELECT 1\s*FROM pages AS page\s*WHERE page\.id = job\.id\s*AND page\.story_id = story\.id\s*AND page\.generated_image_url IS NOT NULL\s*\)/s);
    expect(query.sql).not.toContain("job.last_error");
  });

  it("does not return a comic for a different sender or Twilio destination", async () => {
    h.execute.mockImplementation(async (statement: SQL) => {
      const params = dialect.sqlToQuery(statement).params;
      return {
        rows: params[0] === "+15551112222" && params[5] === "+15553334444"
          ? [{ story_id: storyId, slug: "phone-call-hero", source: "voice" }]
          : [],
      };
    });

    await expect(latestStoryLinkForSms({
      address: "+15559990000",
      senderAddress: "+15553334444",
    })).resolves.toBeNull();
    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "+15558880000",
    })).resolves.toBeNull();
  });

  it("rejects invalid SMS addresses and unsafe result rows", async () => {
    await expect(latestStoryLinkForSms({
      address: "whatsapp:+15551112222",
      senderAddress: "+15553334444",
    })).resolves.toBeNull();
    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "not-a-number",
    })).resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();

    h.execute.mockResolvedValue({ rows: [{
      story_id: storyId,
      slug: "../other-user",
      source: "voice",
    }] });
    await expect(latestStoryLinkForSms({
      address: "+15551112222",
      senderAddress: "+15553334444",
    })).resolves.toBeNull();
  });
});
