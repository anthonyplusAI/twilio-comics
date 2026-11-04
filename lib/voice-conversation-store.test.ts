import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  operations: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  voiceResult: [] as Record<string, unknown>[],
  smsRow: {} as Record<string, unknown>,
  mediaRows: [] as Array<{ mediaUrls: string[]; mediaContentTypes: string[] }>,
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { saveVoiceFreshStart } from "@/lib/voice-conversation-store";

const dialect = new PgDialect();
const previous = {
  id: "52d633c2-1807-44ad-a153-0c79f3c9425e",
  state: "confirming",
  collected: { prompt: "Old comic" },
  activeStoryId: null,
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};
const update = {
  state: "collecting",
  collected: { photoHandoffResetAt: "2026-10-01T00:00:01.000Z" },
  activeStoryId: null,
  freshStart: { phoneNumber: "+15551112222", requestedAt: "2026-10-01T00:00:01.000Z" },
};

beforeEach(() => {
  vi.resetAllMocks();
  h.operations = [];
  h.updates = [];
  h.voiceResult = [{ ...previous, ...update, updatedAt: new Date("2026-10-01T00:00:02.000Z") }];
  h.smsRow = {
    id: "cd817f4c-b2a9-4679-97c4-ab9796789040",
    state: "confirming",
    collected: { prompt: "Old SMS idea", characterImageUrls: ["old-photo"] },
    activeStoryId: null,
  };
  h.mediaRows = [];
  h.select.mockImplementation((projection: Record<string, unknown>) => "mediaUrls" in projection
    ? {
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => h.mediaRows }) }) }),
      }
    : {
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => {
              h.operations.push("lock sms");
              return [h.smsRow];
            } }),
          }),
        }),
      });
  h.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => ({ returning: async () => {
        h.updates.push(values);
        h.operations.push(h.updates.length === 1 ? "save voice" : "reset sms");
        return h.updates.length === 1 ? h.voiceResult : [{ id: "cd817f4c-b2a9-4679-97c4-ab9796789040" }];
      } }),
    }),
  }));
  h.transaction.mockImplementation(async (run: (tx: { select: typeof h.select; update: typeof h.update }) => Promise<unknown>) =>
    run({ select: h.select, update: h.update }));
});

describe("spoken NEW persistence", () => {
  it("locks SMS before Voice, then clears the same-phone SMS draft atomically", async () => {
    const saved = await saveVoiceFreshStart(previous, update);

    expect(h.operations).toEqual(["lock sms", "save voice", "reset sms"]);
    expect(saved).toMatchObject({ state: "collecting", collected: update.collected });
    const sms = h.updates[1];
    expect(dialect.sqlToQuery(sms.state as SQL).sql).toMatch(/state\"? = 'generating'/);
    const collected = dialect.sqlToQuery(sms.collected as SQL);
    expect(collected.sql).toContain("newDraftRequestedAt");
    expect(collected.sql).toContain("phoneRestartedAt");
    expect(collected.sql).toContain("phoneRestartedByMessageSid");
    expect(collected.params).toContain(update.freshStart.requestedAt);
    expect(dialect.sqlToQuery(sms.activeStoryId as SQL).sql).toContain("active_story_id");
  });

  it("does not clear SMS if the Voice revision was superseded", async () => {
    h.voiceResult = [];

    await expect(saveVoiceFreshStart(previous, update)).resolves.toBeNull();

    expect(h.operations).toEqual(["lock sms", "save voice"]);
    expect(h.updates).toHaveLength(1);
  });

  it("preserves a newer texted NEW and its photo when the spoken reset saves late", async () => {
    h.smsRow = {
      ...h.smsRow,
      state: "collecting",
      collected: {
        phoneRestartedAt: "2026-10-01T00:00:03.000Z",
        phoneRestartedByMessageSid: "SM-new",
        characterImageUrls: ["new-photo"],
      },
    };

    await saveVoiceFreshStart(previous, update);

    expect(h.operations).toEqual(["lock sms", "save voice"]);
    expect(h.updates).toHaveLength(1);
    expect(h.smsRow.collected).toMatchObject({ characterImageUrls: ["new-photo"] });
  });

  it("retains a newer saved MMS photo while clearing the older SMS idea", async () => {
    const freshPhoto = "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM-new/Media/ME-new";
    h.smsRow = {
      ...h.smsRow,
      collected: {
        prompt: "Old SMS idea",
        characterImageUrls: ["old-photo", freshPhoto],
      },
    };
    h.mediaRows = [{ mediaUrls: [freshPhoto], mediaContentTypes: ["image/jpeg"] }];

    await saveVoiceFreshStart(previous, update);

    expect(h.operations).toEqual(["lock sms", "save voice", "reset sms"]);
    const collected = dialect.sqlToQuery(h.updates[1].collected as SQL);
    expect(collected.sql).toContain("characterImageUrls");
    expect(collected.params).toContain(JSON.stringify([freshPhoto]));
    expect(collected.params).not.toContain(JSON.stringify(["old-photo", freshPhoto]));
  });

  it("keeps Photos then Call mode after spoken NEW clears the old SMS draft", async () => {
    h.smsRow = {
      ...h.smsRow,
      collected: {
        prompt: "Old SMS idea",
        characterImageUrls: ["old-photo"],
        voicePhotoSetup: true,
      },
    };

    await saveVoiceFreshStart(previous, update);

    const collected = dialect.sqlToQuery(h.updates[1].collected as SQL);
    expect(collected.sql).toMatch(/voicePhotoSetup/);
    expect(collected.sql).toMatch(/voicePhotoSetup'\s*=\s*'true'/);
    expect(collected.sql).not.toMatch(/'prompt',/);
  });
});
