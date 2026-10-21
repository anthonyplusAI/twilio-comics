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
}));

vi.mock("@/lib/db", () => ({
  db: { update: h.update, select: h.select },
}));
vi.mock("@/lib/db-actions", () => ({ getStoryById: h.getStoryById }));
vi.mock("@/lib/twilio", () => ({ sendChannelMessage: h.sendChannelMessage }));
import {
  isMediaDeliveryFailure,
  recordGeneratedMessageStatus,
  recordFallbackMessageStatus,
  recoverFailedMmsTextFallbacks,
  sendFailedMmsTextFallback,
  shouldRecordDeliveryStatus,
} from "@/lib/twilio-delivery";

const jobId = "66b79156-7d64-4bd6-bd67-7e8ce96437ef";
const messageSid = "SM1234567890abcdef1234567890abcdef";

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
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
    h.returning.mockResolvedValue([{ id: jobId }]);
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
    }]);
    h.getStoryById.mockResolvedValue({ slug: "dragon", title: "Dragon Story" });
    h.sendChannelMessage.mockResolvedValue("SMfallback");
    process.env.PUBLIC_BASE_URL = "https://comics.example.com";

    await expect(sendFailedMmsTextFallback(jobId)).resolves.toBe(true);
    expect(h.sendChannelMessage).toHaveBeenCalledWith({
      channel: "sms",
      to: "+15551112222",
      from: "+15550000000",
      body: 'Your comic "Dragon Story" is ready. View it here: https://comics.example.com/story/dragon',
      statusCallback: `https://comics.example.com/api/twilio/status?jobId=${jobId}&fallback=1#rc=3&rp=5xx,ct,rt`,
    });
    const claim = new PgDialect().sqlToQuery(h.where.mock.calls[0][0]);
    expect(claim.sql).toContain('"generation_jobs"."delivery_had_media"');
    expect(claim.sql).toContain('"generation_jobs"."delivery_fallback_attempts"');
    expect(claim.sql).toContain('"generation_jobs"."delivery_fallback_sid"');
  });

  it("does not send when another callback already claimed the fallback", async () => {
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.where.mockReturnValue({ returning: h.returning });
    h.returning.mockResolvedValueOnce([]);
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
