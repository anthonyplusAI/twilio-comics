import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  selectWhere: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  getStoryById: vi.fn(),
  sendChannelMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { update: h.update, select: h.select },
}));
vi.mock("@/lib/db-actions", () => ({ getStoryById: h.getStoryById }));
vi.mock("@/lib/twilio", () => ({ sendChannelMessage: h.sendChannelMessage }));
vi.mock("@/lib/activity-events", () => ({ recordActivityEvent: h.recordActivityEvent }));
import {
  isMediaDeliveryFailure,
  recordGeneratedMessageStatus,
  recordFallbackMessageStatus,
  recordFailedGenerationNoticeStatus,
  recoverFailedMmsTextFallbacks,
  sendFailedMmsTextFallback,
  shouldRecordDeliveryStatus,
} from "@/lib/twilio-delivery";

const jobId = "66b79156-7d64-4bd6-bd67-7e8ce96437ef";
const messageSid = "SM1234567890abcdef1234567890abcdef";

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  h.recordActivityEvent.mockResolvedValue(undefined);
});

describe("Twilio message delivery transitions", () => {
  it("uses a text fallback for media failures but not blocked or opted-out messages", () => {
    expect(isMediaDeliveryFailure("63019")).toBe(true);
    expect(isMediaDeliveryFailure("30011")).toBe(true);
    expect(isMediaDeliveryFailure("21610")).toBe(false);
    expect(isMediaDeliveryFailure("30007")).toBe(false);
    expect(isMediaDeliveryFailure(null)).toBe(false);
  });
  it("records forward progress through delivery and WhatsApp read receipts", () => {
    expect(shouldRecordDeliveryStatus(null, "queued")).toBe(true);
    expect(shouldRecordDeliveryStatus("queued", "sending")).toBe(true);
    expect(shouldRecordDeliveryStatus("sending", "sent")).toBe(true);
    expect(shouldRecordDeliveryStatus("sent", "delivered")).toBe(true);
    expect(shouldRecordDeliveryStatus("delivered", "read")).toBe(true);
  });

  it("preserves terminal delivery results and ignores duplicate or stale callbacks", () => {
    expect(shouldRecordDeliveryStatus("sent", "sending")).toBe(false);
    expect(shouldRecordDeliveryStatus("delivered", "undelivered")).toBe(false);
    expect(shouldRecordDeliveryStatus("undelivered", "delivered")).toBe(false);
    expect(shouldRecordDeliveryStatus("failed", "sent")).toBe(false);
    expect(shouldRecordDeliveryStatus("read", "delivered")).toBe(false);
    expect(shouldRecordDeliveryStatus("sent", "sent")).toBe(false);
  });
});

describe("recordGeneratedMessageStatus", () => {
  it("records a failed-generation notice without changing comic result delivery", async () => {
    h.select.mockReturnValue({ from: h.from });
    h.from.mockReturnValue({ where: h.selectWhere });
    h.selectWhere.mockReturnValue({ limit: h.limit });
    h.limit.mockResolvedValue([{
      id: jobId,
      userId: "user-1",
      source: "voice",
      recipientAddress: "+15551112222",
      attemptCount: 3,
    }]);
    await expect(recordFailedGenerationNoticeStatus({
      jobId,
      messageSid,
      status: "delivered",
      errorCode: null,
    })).resolves.toBe(true);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `message:${messageSid}:status:delivered`,
      kind: "message.delivery",
      channel: "sms",
      address: "+15551112222",
      jobId,
      details: expect.objectContaining({ purpose: "generation_failure_notice" }),
    }));
  });

  it("adds a delivery history event with the job, channel, attempt and error code", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValue([{
      id: jobId,
      userId: "user-1",
      source: "voice",
      recipientAddress: "+15551112222",
      storyId: "story-1",
      attemptCount: 2,
    }]);

    await recordGeneratedMessageStatus({ jobId, messageSid, status: "undelivered", errorCode: "30008" });

    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `message:${messageSid}:status:undelivered`,
      kind: "message.delivery",
      channel: "sms",
      direction: "outbound",
      address: "+15551112222",
      jobId,
      messageSid,
      status: "undelivered",
      details: { source: "voice", fallback: false, errorCode: "30008", attemptCount: 2 },
    }));
  });

  it("keeps the recorded delivery transition when optional history fails", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValue([{ id: jobId, source: "sms", recipientAddress: "+15551112222" }]);
    h.recordActivityEvent.mockRejectedValue(new Error("analytics unavailable"));

    await expect(recordGeneratedMessageStatus({
      jobId, messageSid, status: "delivered", errorCode: null,
    })).resolves.toBe(true);
    expect(h.recordActivityEvent).toHaveBeenCalledOnce();
  });

  it("uses one conditional update tied to the job and Twilio Message SID", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValue([{ id: "job" }]);

    await expect(recordGeneratedMessageStatus({
      jobId,
      messageSid,
      status: "undelivered",
      errorCode: "30008",
    })).resolves.toBe(true);

    expect(h.update).toHaveBeenCalledOnce();
    expect(h.set.mock.calls[0][0]).toMatchObject({
      deliveryStatus: "undelivered",
      deliveryErrorCode: "30008",
    });
    const query = new PgDialect().sqlToQuery(h.where.mock.calls[0][0]);
    expect(query.sql).toContain('"generation_jobs"."id"');
    expect(query.sql).toContain('"generation_jobs"."delivery_sid"');
    expect(query.sql).toContain('"generation_jobs"."delivery_status"');
    expect(query.params).toContain(jobId);
    expect(query.params).toContain(messageSid);
  });

  it("records fallback callbacks against their own SID and status", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValue([{
      id: jobId,
      userId: "user-1",
      source: "sms",
      recipientAddress: "+15551112222",
      storyId: "story-1",
      attemptCount: 1,
    }]);
    await expect(recordFallbackMessageStatus({
      jobId,
      messageSid,
      status: "delivered",
      errorCode: null,
    })).resolves.toBe(true);
    const query = new PgDialect().sqlToQuery(h.where.mock.calls.at(-1)![0]);
    expect(query.sql).toContain('"generation_jobs"."delivery_fallback_sid"');
    expect(query.sql).toContain('"generation_jobs"."delivery_fallback_status"');
    expect(query.params).toContain(messageSid);
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `message:${messageSid}:status:delivered`,
      kind: "message.delivery",
      details: { source: "sms", fallback: true, errorCode: null, attemptCount: 1 },
    }));
  });

  it("captures an early queued fallback SID without regressing its sending state", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValue([{ id: jobId }]);
    await recordFallbackMessageStatus({
      jobId,
      messageSid,
      status: "queued",
      errorCode: null,
    });
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(h.where.mock.calls[0][0]);
    const update = dialect.sqlToQuery(h.set.mock.calls[0][0].deliveryFallbackStatus);
    expect(predicate.sql).toContain('"generation_jobs"."delivery_fallback_sid" is null');
    expect(predicate.sql).toContain('"generation_jobs"."delivery_fallback_status" =');
    expect(update.sql).toContain("CASE WHEN");
    expect(update.sql).toContain("THEN 'sending'");
  });
});

describe("sendFailedMmsTextFallback", () => {
  it("durably suppresses an expired MMS text fallback and keeps its comic history", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: jobId,
        userId: "user-1",
        source: "sms",
        recipientAddress: "+15551112222",
        storyId: "story-1",
        attemptCount: 1,
      }]);

    await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(false);

    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.getStoryById).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({
      deliveryFallbackStatus: "suppressed",
    }));
    const claim = new PgDialect().sqlToQuery(h.where.mock.calls[0][0]);
    expect(claim.sql).toContain('"generation_jobs"."created_at"');
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `job:${jobId}:fallback:suppressed`,
      kind: "generation.delivery",
      status: "suppressed",
      storyId: "story-1",
      details: expect.objectContaining({ reason: "delivery_window_expired", fallback: true }),
    }));
  });

  it("suppresses a fallback if the lookup crosses the 24-hour deadline", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-10-21T12:00:00.000Z");
      vi.setSystemTime(new Date(startedAt.getTime() + 24 * 60 * 60 * 1000 - 30_000));
      h.update.mockReturnValue({ set: h.set });
      h.set.mockReturnValue({ where: h.where });
      h.where.mockReturnValue({ returning: h.returning });
      h.returning
        .mockResolvedValueOnce([{
          id: jobId,
          createdAt: startedAt,
          storyId: "story-1",
          source: "sms",
          recipientAddress: "+15551112222",
          senderAddress: "+15550000000",
          deliveryFallbackAttempts: 1,
        }])
        .mockResolvedValueOnce([{
          id: jobId,
          userId: "user-1",
          source: "sms",
          recipientAddress: "+15551112222",
          storyId: "story-1",
          attemptCount: 1,
        }]);
      h.getStoryById.mockImplementation(async () => {
        vi.setSystemTime(new Date(startedAt.getTime() + 24 * 60 * 60 * 1000 + 1000));
        return { slug: "dragon", title: "Dragon Story" };
      });
      process.env.PUBLIC_BASE_URL = "https://comics.example.com";

      await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(false);

      expect(h.getStoryById).toHaveBeenCalledOnce();
      expect(h.sendChannelMessage).not.toHaveBeenCalled();
      expect(h.set).toHaveBeenLastCalledWith(expect.objectContaining({
        deliveryFallbackStatus: "suppressed",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims one bounded attempt and sends the existing story link", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValueOnce([{
      id: jobId,
      storyId: "story-1",
      source: "voice",
      recipientAddress: "+15551112222",
      senderAddress: "+15550000000",
      deliveryFallbackAttempts: 1,
      createdAt: new Date(Date.now() - 60_000),
    }]);
    h.getStoryById.mockResolvedValue({ slug: "dragon", title: "Dragon Story" });
    h.sendChannelMessage.mockResolvedValue("SMfallback");
    process.env.PUBLIC_BASE_URL = "https://comics.example.com";

    await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(true);
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `job:${jobId}:fallback:SMfallback:accepted`,
      kind: "generation.delivery",
      messageSid: "SMfallback",
      status: "accepted",
      details: expect.objectContaining({ fallback: true, hadMedia: false }),
    }));
    expect(h.sendChannelMessage).toHaveBeenCalledWith({
      channel: "sms",
      to: "+15551112222",
      from: "+15550000000",
      body: 'Your comic "Dragon Story" is ready. View it here: https://comics.example.com/story/dragon',
      validityPeriod: 36000,
      statusCallback: `https://comics.example.com/api/twilio/status?jobId=${jobId}&fallback=1#rc=3&rp=5xx,ct,rt`,
    });
    const claim = new PgDialect().sqlToQuery(h.where.mock.calls[0][0]);
    expect(claim.sql).toContain('"generation_jobs"."delivery_had_media"');
    expect(claim.sql).toContain('"generation_jobs"."delivery_fallback_attempts"');
    expect(claim.sql).toContain('"generation_jobs"."delivery_fallback_sid"');
  });

  it("sends the saved Dub link when an MMS preview needs text fallback", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValueOnce([{
      id: jobId,
      storyId: "story-1",
      source: "sms",
      recipientAddress: "+15551112222",
      senderAddress: "+15550000000",
      deliveryFallbackAttempts: 1,
      createdAt: new Date(Date.now() - 60_000),
    }]);
    h.getStoryById.mockResolvedValue({
      slug: "dragon",
      title: "Dragon Story",
      dubShortUrl: "https://twil.io/comic-33",
    });
    h.sendChannelMessage.mockResolvedValue("SMfallback");
    process.env.PUBLIC_BASE_URL = "https://comics.example.com";

    await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(true);
    expect(h.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Your comic "Dragon Story" is ready. View it here: https://twil.io/comic-33',
    }));
  });

  it("bounds an MMS fallback's Twilio queue time to the remaining lifetime", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-10-21T12:00:00.000Z");
      vi.setSystemTime(new Date(startedAt.getTime() + 24 * 60 * 60 * 1000 - 30_000));
      h.update.mockReturnValue({ set: h.set });
      h.set.mockReturnValue({ where: h.where });
      h.where.mockReturnValue({ returning: h.returning });
      h.returning.mockResolvedValueOnce([{
        id: jobId,
        createdAt: startedAt,
        storyId: "story-1",
        source: "voice",
        recipientAddress: "+15551112222",
        senderAddress: "+15550000000",
        deliveryFallbackAttempts: 1,
      }]);
      h.getStoryById.mockResolvedValue({ slug: "dragon", title: "Dragon Story" });
      h.sendChannelMessage.mockResolvedValue("SMfallback");
      process.env.PUBLIC_BASE_URL = "https://comics.example.com";

      await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(true);

      expect(h.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
        validityPeriod: 20,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send when another callback already claimed the fallback", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(false);
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("retries eligible failed MMS deliveries in the scheduled recovery sweep", async () => {
    h.select.mockReturnValue({ from: h.from });
    h.from.mockReturnValue({ where: h.selectWhere });
    h.selectWhere.mockReturnValue({ orderBy: h.orderBy });
    h.orderBy.mockReturnValue({ limit: h.limit });
    h.limit.mockResolvedValue([{ id: jobId }]);
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValueOnce([{
      id: jobId,
      storyId: "story-1",
      source: "sms",
      recipientAddress: "+15551112222",
      senderAddress: "+15550000000",
      deliveryFallbackAttempts: 2,
      createdAt: new Date(Date.now() - 60_000),
    }]);
    h.getStoryById.mockResolvedValue({ slug: "dragon", title: "Dragon Story" });
    h.sendChannelMessage.mockResolvedValue("SMfallback");
    process.env.PUBLIC_BASE_URL = "https://comics.example.com";

    await expect(recoverFailedMmsTextFallbacks()).resolves.toBe(1);
    const eligible = new PgDialect().sqlToQuery(h.selectWhere.mock.calls[0][0]);
    expect(eligible.sql).toContain('"generation_jobs"."delivery_had_media"');
    expect(eligible.sql).toContain('"generation_jobs"."delivery_fallback_lease_expires_at"');
    expect(h.sendChannelMessage).toHaveBeenCalledOnce();
  });
});
