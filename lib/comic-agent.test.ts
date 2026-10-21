import { describe, expect, it, vi } from "vitest";
import {
  advanceComicAgent,
  emptyAgentCollected,
  type ComicAgentModel,
} from "@/lib/comic-agent";

const IDEA = "A shy astronaut meets a dragon on the moon";

function modelReply(overrides: Partial<Awaited<ReturnType<ComicAgentModel>>> = {}) {
  return vi.fn<ComicAgentModel>().mockResolvedValue({
    reply: "An astronaut and a dragon on the moon. Does that sound right?",
    prompt: IDEA,
    style: "manga",
    readyForConfirmation: true,
    ...overrides,
  });
}

describe("advanceComicAgent", () => {
  it("turns an initial comic idea into a draft requiring explicit approval", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      { state: "awaiting_name", collected: emptyAgentCollected() },
      { text: IDEA, channel: "sms" },
      model,
    );

    expect(model).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      nextState: "confirming",
      action: "none",
      activeStoryId: null,
      collected: { prompt: IDEA, style: "manga" },
    });
    expect(result.reply).toContain("CREATE");
    expect(result.submission).toBeUndefined();
  });

  it("submits the saved draft only on CREATE", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      {
        state: "confirming",
        activeStoryId: "story-1",
        collected: {
          prompt: IDEA,
          style: "manga",
          characterImageUrls: ["https://example.com/face.jpg"],
          targetStoryId: "story-1",
        },
      },
      { text: "CREATE", channel: "sms" },
      model,
    );

    expect(model).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "submit",
      nextState: "generating",
      activeStoryId: "story-1",
      submission: {
        prompt: IDEA,
        style: "manga",
        characterImageUrls: ["https://example.com/face.jpg"],
        targetStoryId: "story-1",
      },
    });
    expect(result.collected.prompt).toBe(IDEA);
  });

  it("treats revisions as conversation, not approval", async () => {
    const model = modelReply({ prompt: `${IDEA} and they find a tiny robot` });
    const result = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "manga" } },
      { text: "Yes, but add a tiny robot", channel: "sms" },
      model,
    );

    expect(model).toHaveBeenCalledOnce();
    expect(result.action).toBe("none");
    expect(result.nextState).toBe("confirming");
    expect(result.collected.prompt).toContain("tiny robot");
  });

  it("accepts a photo-only turn and keeps at most two references", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      { state: "collecting", collected: emptyAgentCollected() },
      {
        text: "",
        channel: "sms",
        imageUrls: ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
      },
      model,
    );

    expect(model).not.toHaveBeenCalled();
    expect(result.nextState).toBe("collecting");
    expect(result.collected.characterImageUrls).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect(result.reply).toMatch(/idea/i);
  });

  it("allows a reference to be added to a pending draft before approval", async () => {
    const result = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "manga" } },
      { text: "", channel: "whatsapp", imageUrls: ["https://example.com/face"] },
      modelReply(),
    );

    expect(result.nextState).toBe("confirming");
    expect(result.collected.characterImageUrls).toEqual(["https://example.com/face"]);
    expect(result.reply).toContain("CREATE");
    expect(result.action).toBe("none");
  });

  it("keeps a generation locked against NEW and DISCARD", async () => {
    for (const text of ["NEW", "DISCARD"]) {
      const result = await advanceComicAgent(
        { state: "generating", collected: { prompt: IDEA, style: "manga" } },
        { text, channel: "sms" },
        modelReply(),
      );
      expect(result.nextState).toBe("generating");
      expect(result.collected.prompt).toBe(IDEA);
      expect(result.reply).toMatch(/working|creating|generat/i);
    }
  });

  it("starts a continuation draft tied to the completed story", async () => {
    const next = await advanceComicAgent(
      {
        state: "done",
        activeStoryId: "story-1",
        collected: { prompt: IDEA, style: "manga" },
      },
      { text: "CONTINUE", channel: "sms" },
      modelReply(),
    );
    expect(next).toMatchObject({
      nextState: "collecting",
      activeStoryId: "story-1",
      collected: { targetStoryId: "story-1", style: "manga" },
    });
    expect(next.reply).toMatch(/next page/i);

    const model = modelReply({ prompt: "The dragon and astronaut find an alien city" });
    const drafted = await advanceComicAgent(
      { state: next.nextState, activeStoryId: next.activeStoryId, collected: next.collected },
      { text: "They find an alien city", channel: "sms" },
      model,
    );
    const confirmed = await advanceComicAgent(
      { state: drafted.nextState, activeStoryId: drafted.activeStoryId, collected: drafted.collected },
      { text: "CREATE", channel: "sms" },
      model,
    );
    expect(confirmed.submission?.targetStoryId).toBe("story-1");
  });

  it("preserves a completed story when a continuation draft is cancelled", async () => {
    const result = await advanceComicAgent(
      {
        state: "confirming",
        activeStoryId: "story-1",
        collected: { prompt: "A sequel", targetStoryId: "story-1" },
      },
      { text: "CANCEL", channel: "voice" },
      modelReply(),
    );
    expect(result).toMatchObject({
      nextState: "done",
      activeStoryId: "story-1",
      collected: {},
    });
  });

  it("uses a spoken approval phrase for voice calls", async () => {
    const result = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "noir" } },
      { text: "create it", channel: "voice" },
      modelReply(),
    );
    expect(result.action).toBe("submit");
    expect(result.submission?.prompt).toBe(IDEA);
  });

  it("recognizes spoken commands with sentence punctuation", async () => {
    const model = modelReply();
    const current = {
      state: "done",
      activeStoryId: "story-1",
      collected: { prompt: IDEA, style: "manga" },
    };
    const status = await advanceComicAgent(current, { text: "  Status.  ", channel: "voice" }, model);
    expect(status.nextState).toBe("done");
    expect(status.reply).toContain("Say CONTINUE");

    const continuation = await advanceComicAgent(current, { text: "Continue!", channel: "voice" }, model);
    expect(continuation).toMatchObject({
      nextState: "collecting",
      activeStoryId: "story-1",
      collected: { targetStoryId: "story-1", style: "manga" },
    });
    expect(model).not.toHaveBeenCalled();
  });

  it("recognizes punctuated reset and cancellation commands without treating ideas as commands", async () => {
    const model = modelReply();
    const current = { state: "confirming", collected: { prompt: IDEA, style: "manga" } };
    const cancelled = await advanceComicAgent(current, { text: "Discard?", channel: "sms" }, model);
    expect(cancelled.nextState).toBe("collecting");
    expect(cancelled.collected).toEqual({});

    const reset = await advanceComicAgent(current, { text: "New...", channel: "voice" }, model);
    expect(reset.nextState).toBe("collecting");
    expect(reset.collected).toEqual({});
    expect(model).not.toHaveBeenCalled();

    await advanceComicAgent(current, { text: "Continue the battle.", channel: "voice" }, model);
    expect(model).toHaveBeenCalledOnce();
  });

  it("does not treat Twilio's CANCEL opt-out keyword as a text draft command", async () => {
    const model = modelReply();
    const current = { state: "confirming", collected: { prompt: IDEA, style: "manga" } };

    const result = await advanceComicAgent(current, { text: "CANCEL", channel: "sms" }, model);

    expect(model).toHaveBeenCalledOnce();
    expect(result.collected.prompt).toBe(IDEA);
    expect(result.nextState).toBe("confirming");
  });

  it("speaks status and continuation instructions on a call", async () => {
    const generating = await advanceComicAgent(
      { state: "generating", collected: { prompt: IDEA } },
      { text: "status", channel: "voice" },
      modelReply(),
    );
    expect(generating.reply).toContain("Say STATUS");

    const done = await advanceComicAgent(
      { state: "done", collected: { prompt: IDEA }, activeStoryId: "story-1" },
      { text: "status", channel: "voice" },
      modelReply(),
    );
    expect(done.reply).toContain("Say CONTINUE");
  });

  it.each(["STATUS", "NEW", ""])("guides Voice callers without offering photos for %j", async (text) => {
    const model = modelReply();
    const response = await advanceComicAgent(
      { state: "collecting", collected: emptyAgentCollected() },
      { text, channel: "voice" },
      model,
    );

    expect(response.reply).toMatch(/comic|idea/i);
    expect(response.reply).toMatch(/character|happen/i);
    expect(response.reply).not.toMatch(/photo|attach|image/i);
    expect(model).not.toHaveBeenCalled();
  });

  it.each(["sms", "whatsapp"] as const)("keeps character-photo guidance for %s", async (channel) => {
    for (const text of ["STATUS", "NEW", ""]) {
      const response = await advanceComicAgent(
        { state: "collecting", collected: emptyAgentCollected() },
        { text, channel },
        modelReply(),
      );

      expect(response.reply).toMatch(/two character photos|two photos/i);
    }
  });

  it("rejects an oversized user turn before calling the model", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      { state: "collecting", collected: emptyAgentCollected() },
      { text: "x".repeat(4001), channel: "sms" },
      model,
    );
    expect(model).not.toHaveBeenCalled();
    expect(result.nextState).toBe("collecting");
    expect(result.reply).toMatch(/shorten/i);
  });

  it("bounds the conversation history sent to the model", async () => {
    const model = modelReply();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`,
    }));
    const result = await advanceComicAgent(
      { state: "collecting", collected: { messages } },
      { text: IDEA, channel: "sms" },
      model,
    );
    expect(model.mock.calls[0][0].history.length).toBeLessThanOrEqual(12);
    expect(result.collected.messages?.length).toBeLessThanOrEqual(12);
    expect(result.collected.messages?.at(-1)?.role).toBe("assistant");
  });
});
