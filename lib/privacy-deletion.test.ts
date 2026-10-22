import { describe, expect, it } from "vitest";
import {
  buildDeletionPlan,
  deletionSubjectForSender,
  type SubjectDatabaseSnapshot,
} from "@/lib/privacy-deletion";

const sender = "+15551234567";
const userId = "twilio_8a59780bb8cd2ba022bfa5ba2ea3b6e0";
const firstJob = "11111111-1111-4111-8111-111111111111";
const firstStory = "22222222-2222-4222-8222-222222222222";

function snapshot(overrides: Partial<SubjectDatabaseSnapshot> = {}): SubjectDatabaseSnapshot {
  return {
    user: { id: userId, kind: "channel", email: null },
    identities: [
      { userId, normalizedAddress: sender, channel: "sms", provider: "twilio" },
      { userId, normalizedAddress: sender, channel: "voice", provider: "twilio" },
    ],
    jobs: [{
      id: firstJob,
      userId,
      recipientAddress: sender,
      status: "succeeded",
      storyId: firstStory,
      targetStoryId: null,
      deliveryFallbackStatus: null,
      deliverySid: "SM11111111111111111111111111111111",
      deliveryFallbackSid: null,
    }],
    stories: [{ id: firstStory, userId }],
    messages: [{
      messageSid: "SM22222222222222222222222222222222",
      outboundSid: "SM33333333333333333333333333333333",
    }],
    calls: [{ callSid: "CA11111111111111111111111111111111" }],
    eventSids: [{
      messageSid: "SM44444444444444444444444444444444",
      callSid: null,
    }],
    counts: {
      users: 1,
      channelIdentities: 2,
      conversations: 1,
      inboundMessages: 1,
      voiceCalls: 1,
      generationJobs: 1,
      stories: 1,
      pages: 1,
      activityEvents: 30,
      feedback: 0,
      quotaRows: 1,
      quotaClaims: 1,
      accounts: 0,
      sessions: 0,
      verificationTokens: 0,
      activeInboundMessages: 0,
      activeVoiceCalls: 0,
      activeConversations: 0,
      mixedOwnershipEvents: 0,
      mixedOwnershipCalls: 0,
    },
    ...overrides,
  };
}

describe("subject deletion inventory", () => {
  it("requires an exact E.164 sender and derives the channel user ID", () => {
    expect(deletionSubjectForSender(sender)).toEqual({
      sender,
      userId,
      addresses: [sender, `whatsapp:${sender}`],
    });
    expect(() => deletionSubjectForSender("+1 (555) 123-4567")).toThrow(/E\.164/);
    expect(() => deletionSubjectForSender("whatsapp:+15551234567")).toThrow(/E\.164/);
  });

  it("includes all current per-user, per-job, and per-story blob prefixes", () => {
    const plan = buildDeletionPlan(sender, snapshot());

    expect(plan.blobPrefixes).toEqual([
      `${firstStory}/`,
      `references/twilio/${firstJob}/`,
      `stories/${firstJob}/`,
      `stories/${firstStory}/`,
      `uploads/${userId}/`,
    ]);
    expect(plan.counts).toEqual(snapshot().counts);
    expect(plan.providerMessageSids).toEqual([
      "SM11111111111111111111111111111111",
      "SM22222222222222222222222222222222",
      "SM33333333333333333333333333333333",
      "SM44444444444444444444444444444444",
    ]);
    expect(plan.providerCallSids).toEqual(["CA11111111111111111111111111111111"]);
    expect(plan.blockers).toEqual([]);
    expect(plan.readOnly).toBe(true);
  });

  it("refuses to mark active work as ready for manual erasure", () => {
    const base = snapshot();
    const plan = buildDeletionPlan(sender, snapshot({
      jobs: [{ ...base.jobs[0], status: "processing", deliveryFallbackStatus: "retry_pending" }],
      counts: {
        ...base.counts,
        activeInboundMessages: 1,
        activeVoiceCalls: 1,
        activeConversations: 1,
      },
    }));

    expect(plan.readyForManualDeletion).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/generation job/i);
    expect(plan.blockers.join(" ")).toMatch(/inbound/);
    expect(plan.blockers.join(" ")).toMatch(/voice call/);
    expect(plan.blockers.join(" ")).toMatch(/conversation/);
  });

  it("flags mixed ownership instead of claiming all linked records belong to the sender", () => {
    const base = snapshot();
    const foreignUser = "google_user_other";
    const plan = buildDeletionPlan(sender, snapshot({
      user: { id: userId, kind: "oauth", email: "owner@example.com" },
      identities: [
        ...base.identities,
        { userId: foreignUser, normalizedAddress: sender, channel: "whatsapp", provider: "twilio" },
        { userId, normalizedAddress: "+15557654321", channel: "sms", provider: "twilio" },
      ],
      jobs: [
        ...base.jobs,
        { ...base.jobs[0], id: "33333333-3333-4333-8333-333333333333", userId: foreignUser },
      ],
      counts: { ...base.counts, accounts: 1 },
    }));

    expect(plan.readyForManualDeletion).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/identity|account|owner/i);
    expect(plan.blobPrefixes).not.toContain("references/twilio/33333333-3333-4333-8333-333333333333/");
  });

  it("blocks an orphan channel user and a non-Twilio identity", () => {
    const base = snapshot();
    const orphan = buildDeletionPlan(sender, snapshot({
      identities: [],
      counts: { ...base.counts, channelIdentities: 0 },
    }));
    const otherProvider = buildDeletionPlan(sender, snapshot({
      identities: [{ userId, normalizedAddress: sender, channel: "sms", provider: "other" }],
      counts: { ...base.counts, channelIdentities: 1 },
    }));

    expect(orphan.readyForManualDeletion).toBe(false);
    expect(orphan.blockers.join(" ")).toMatch(/matching identity/);
    expect(otherProvider.readyForManualDeletion).toBe(false);
    expect(otherProvider.blockers.join(" ")).toMatch(/identity/);
  });

  it("blocks address history that is attributed to another user", () => {
    const base = snapshot();
    const plan = buildDeletionPlan(sender, snapshot({
      counts: {
        ...base.counts,
        mixedOwnershipEvents: 2,
        mixedOwnershipCalls: 1,
      },
    }));

    expect(plan.readyForManualDeletion).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/different user/);
  });
});
