import { describe, expect, it } from "vitest";
import {
  voiceConversationRelayTwiML,
  voiceMissingPhotoPrompt,
} from "@/lib/voice-twiml";

const BASE = "https://comics.example";
const RELAY = "wss://comics.example/relay";

async function greeting(readiness: Parameters<typeof voiceConversationRelayTwiML>[3]): Promise<string> {
  const response = voiceConversationRelayTwiML(BASE, RELAY, "signed-call", readiness);
  const xml = await response.text();
  const match = xml.match(/welcomeGreeting="([^"]+)"/);
  expect(match).not.toBeNull();
  return match?.[1].replaceAll("&apos;", "'").replaceAll("&quot;", '"') ?? "";
}

describe("Voice call guidance", () => {
  it.each([[1, "one saved reference photo"], [2, "two saved reference photos"]])(
    "acknowledges %i saved photos before inviting a new idea",
    async (count, expected) => {
      const spoken = await greeting({ kind: "photos", count });
      expect(spoken).toContain(expected);
      expect(spoken).toMatch(/tell me.+comic.+happens/i);
      expect(spoken).toMatch(/recap.+correct.+say create it/i);
    },
  );

  it("guides a finished comic toward continuation or fresh photos", async () => {
    const spoken = await greeting({ kind: "continuation", phase: "finished" });
    expect(spoken).toMatch(/say continue.+page/i);
    expect(spoken).toMatch(/new comic.+new photos.+call/i);
    expect(spoken).not.toMatch(/photo page/i);
    expect(spoken).not.toMatch(/tell me your comic idea/i);
  });

  it("resumes an unfinished next-page draft without asking for CONTINUE again", async () => {
    const spoken = await greeting({ kind: "continuation", phase: "draft" });
    expect(spoken).toMatch(/next.page draft.+saved/i);
    expect(spoken).toMatch(/tell me what to add or change/i);
    expect(spoken).toMatch(/recap.+say create it/i);
    expect(spoken).not.toMatch(/say continue/i);
  });

  it("opens an in-progress call with status and result delivery", async () => {
    const spoken = await greeting({ kind: "generating" });
    expect(spoken).toMatch(/still creating.+comic/i);
    expect(spoken).toMatch(/text.+link.+ready/i);
    expect(spoken).toMatch(/say status/i);
    expect(spoken).not.toMatch(/tell me your comic idea/i);
  });

  it("keeps the call disclosures in every connected greeting", async () => {
    for (const readiness of [
      { kind: "photos", count: 1 } as const,
      { kind: "continuation", phase: "finished" } as const,
      { kind: "continuation", phase: "draft" } as const,
      { kind: "generating" } as const,
    ]) {
      const spoken = await greeting(readiness);
      expect(spoken).toMatch(/AI agent transcribes this call/i);
      expect(spoken).toMatch(/text comic links to the number/i);
      expect(spoken).toMatch(/hang up now/i);
      expect(spoken).toMatch(/privacy and terms.+website/i);
    }
  });

  it("never opens Relay if readiness is missing", async () => {
    const xml = await voiceConversationRelayTwiML(
      BASE, RELAY, "signed-call", { kind: "missing" },
    ).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<ConversationRelay");
  });

  it("tells text-capable callers to save MMS photos before calling again", () => {
    const spoken = voiceMissingPhotoPrompt(true);
    expect(spoken).toMatch(/text one or two photos.+same phone/i);
    expect(spoken).toMatch(/wait.+photo saved.+call again/i);
  });

  it("does not send Voice-only callers to the retired photo page", () => {
    const spoken = voiceMissingPhotoPrompt(false);
    expect(spoken).toMatch(/photo setup.+unavailable.+try again later/i);
    expect(spoken).not.toMatch(/photo page/i);
    expect(spoken).not.toMatch(/text one or two photos/i);
  });
});
