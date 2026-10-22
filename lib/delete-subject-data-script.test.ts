import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runDeletionInventory } from "../scripts/delete-subject-data";
import type { SubjectDatabaseSnapshot } from "@/lib/privacy-deletion";

const sender = "+15551234567";
const userId = "twilio_8a59780bb8cd2ba022bfa5ba2ea3b6e0";

function snapshot(activeInboundMessages = 0): SubjectDatabaseSnapshot {
  return {
    user: { id: userId, kind: "channel", email: null },
    identities: [{ userId, normalizedAddress: sender, channel: "sms", provider: "twilio" }],
    jobs: [],
    stories: [],
    messages: [{ messageSid: "SM22222222222222222222222222222222", outboundSid: null }],
    calls: [],
    eventSids: [],
    counts: {
      users: 1,
      channelIdentities: 1,
      conversations: 1,
      inboundMessages: 1,
      voiceCalls: 0,
      generationJobs: 0,
      stories: 0,
      pages: 0,
      activityEvents: 1,
      feedback: 0,
      quotaRows: 1,
      quotaClaims: 0,
      accounts: 0,
      sessions: 0,
      verificationTokens: 0,
      activeInboundMessages,
      activeVoiceCalls: 0,
      activeConversations: 0,
      mixedOwnershipEvents: 0,
      mixedOwnershipCalls: 0,
    },
  };
}

describe("deletion inventory command", () => {
  it("defaults to a read-only JSON inventory with exact blob keys", async () => {
    const result = await runDeletionInventory(
      ["--sender", sender, "--json"],
      {
        loadSnapshot: async () => snapshot(),
        listBlobKeys: async () => [`uploads/${userId}/photo.jpg`],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      sender,
      readOnly: true,
      readyForManualDeletion: true,
      blobObjectCount: 1,
      blobKeys: [`uploads/${userId}/photo.jpg`],
      counts: { inboundMessages: 1, activityEvents: 1 },
    });
  });

  it("returns a blocking exit code when an inbound receipt is unfinished", async () => {
    const result = await runDeletionInventory(
      ["--sender", sender, "--json"],
      {
        loadSnapshot: async () => snapshot(1),
        listBlobKeys: async () => [],
      },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).blockers).toEqual([
      "1 inbound message receipt(s) are unfinished.",
    ]);
  });

  it("rejects execution before accessing a database or storage account", async () => {
    await expect(runDeletionInventory(
      ["--execute", "--sender", sender, "--confirm", sender],
      {
        loadSnapshot: async () => { throw new Error("should not query database"); },
        listBlobKeys: async () => { throw new Error("should not query storage"); },
      },
    )).rejects.toThrow(/read-only/);
  });

  it("shows help from the actual CLI without production credentials", () => {
    const command = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/delete-subject-data.ts", "--help",
    ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });

    expect(command.status).toBe(0);
    expect(command.stdout).toMatch(/--sender/);
    expect(command.stdout).toMatch(/read-only/i);
  }, 15_000);
});
