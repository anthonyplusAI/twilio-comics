import { describe, expect, it, vi } from "vitest";
import {
  advanceComicAgent,
  emptyAgentCollected,
  type ComicAgentModel,
} from "@/lib/comic-agent";
import { COMIC_START_MESSAGE } from "@/lib/marketing-contact";

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
    expect(result.reply).toMatch(/sound right\?\n\nReply CREATE/);
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

  it("says when a third SMS photo is not retained", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { characterImageUrls: ["photo-1", "photo-2"] } },
      { text: "", channel: "sms", imageUrls: ["photo-3"] },
      modelReply(),
    );

    expect(result.collected.characterImageUrls).toEqual(["photo-1", "photo-2"]);
    expect(result.reply).toMatch(/up to two photos/i);
    expect(result.reply).not.toMatch(/photo saved|photo received/i);
  });

  it("keeps handed-off SMS photos for an idea but starts a fresh set on the next MMS", async () => {
    const current = {
      state: "collecting",
      collected: {
        characterImageUrls: ["photo-1", "photo-2"],
        photoHandoffFingerprint: "transferred",
      },
    };
    const idea = await advanceComicAgent(current, { text: IDEA, channel: "sms" }, modelReply());
    expect(idea.collected.characterImageUrls).toEqual(["photo-1", "photo-2"]);

    const nextSet = await advanceComicAgent(
      current,
      { text: "", channel: "sms", imageUrls: ["photo-3"] },
      modelReply(),
    );
    expect(nextSet.collected.characterImageUrls).toEqual(["photo-3"]);
    expect(nextSet.collected.photoHandoffFingerprint).toBeUndefined();
    expect(nextSet.reply).toMatch(/photo saved/i);
  });

  it.each(["NEW", "RESET", "RESTART"])("keeps photos attached to an SMS %s in its fresh draft", async (command) => {
    const reset = await advanceComicAgent(
      {
        state: "confirming",
        collected: { prompt: IDEA, characterImageUrls: ["old-photo"] },
      },
      { text: command, channel: "sms", imageUrls: ["new-photo"] },
      modelReply(),
    );

    expect(reset.nextState).toBe("collecting");
    expect(reset.collected.prompt).toBeUndefined();
    expect(reset.collected.characterImageUrls).toEqual(["new-photo"]);
    expect(reset.reply).toMatch(/photo saved/i);
    expect(reset.reply).toMatch(/comic idea/i);
  });

  it.each(["sms", "whatsapp"] as const)(
    "treats the suggested %s opening text as an invitation to send photos and an idea",
    async (channel) => {
      const model = modelReply();
      const result = await advanceComicAgent(
        { state: "collecting", collected: emptyAgentCollected() },
        { text: COMIC_START_MESSAGE, channel },
        model,
      );

      expect(model).not.toHaveBeenCalled();
      expect(result).toMatchObject({ nextState: "collecting", action: "none", collected: {} });
      expect(result.reply).toMatch(/photos of yourself/i);
      expect(result.reply).toMatch(/comic idea/i);
    },
  );

  it("keeps an existing draft and adds attached photos when the text link is tapped again", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      {
        state: "confirming",
        collected: {
          prompt: IDEA,
          style: "manga",
          characterImageUrls: ["https://example.com/first"],
        },
      },
      {
        text: COMIC_START_MESSAGE,
        channel: "sms",
        imageUrls: ["https://example.com/second"],
      },
      model,
    );

    expect(model).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      nextState: "confirming",
      action: "none",
      collected: {
        prompt: IDEA,
        style: "manga",
        characterImageUrls: ["https://example.com/first", "https://example.com/second"],
      },
    });
    expect(result.reply).toContain("CREATE");
  });

  it("lets a verified caller skip staged photos without losing the idea", async () => {
    const model = modelReply();
    const result = await advanceComicAgent(
      {
        state: "confirming",
        collected: {
          prompt: IDEA,
          style: "manga",
          characterImageUrls: ["https://example.com/first"],
          photoHandoffFingerprint: "same-source",
        },
      },
      { text: "Skip photos.", channel: "voice" },
      model,
    );

    expect(model).not.toHaveBeenCalled();
    expect(result.collected).toMatchObject({
      prompt: IDEA,
      style: "manga",
      characterImageUrls: [],
      photoHandoffFingerprint: "same-source",
      suppressPhotoHandoff: true,
    });
    expect(result.reply).toContain("create it");
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

  it("asks for a revision when STATUS follows a blocked generation", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "STATUS", channel: "sms" },
      modelReply(),
    );

    expect(result.nextState).toBe("collecting");
    expect(result.reply).toMatch(/change|revise/i);
    expect(result.reply).not.toMatch(/ready for your comic idea/i);
  });

  it("does not submit CREATE again until a blocked prompt has changed", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "CREATE", channel: "sms" },
      modelReply(),
    );

    expect(result.action).toBe("none");
    expect(result.nextState).toBe("collecting");
    expect(result.reply).toMatch(/change|revise/i);
  });

  it("keeps a blocked prompt out of confirming when the model repeats it", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "Maybe make it work", channel: "sms" },
      modelReply({ prompt: IDEA, readyForConfirmation: true }),
    );

    expect(result.nextState).toBe("collecting");
    expect(result.collected.blockedPrompt).toBe(IDEA);
    expect(result.reply).toMatch(/change|revise/i);
    expect(result.reply).not.toMatch(/reply CREATE/i);
  });

  it("does not treat punctuation-only edits of a declined prompt as a revision", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "Try that again, please", channel: "sms" },
      modelReply({ prompt: `  ${IDEA}...  `, readyForConfirmation: true }),
    );

    expect(result.nextState).toBe("collecting");
    expect(result.collected.blockedPrompt).toBe(IDEA);
    expect(result.reply).toMatch(/change/i);
  });

  it("asks for a revision even when the model repeats a declined idea without approval", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "Try again", channel: "sms" },
      modelReply({ prompt: IDEA, reply: "This sounds ready to make.", readyForConfirmation: false }),
    );

    expect(result.nextState).toBe("collecting");
    expect(result.reply).toMatch(/change/i);
    expect(result.reply).not.toMatch(/ready to make/i);
  });

  it("clears a blocked prompt after a revised draft passes preflight", async () => {
    const result = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "Instead, make it a playful adventure", channel: "voice" },
      modelReply({ prompt: "A playful dragon and astronaut explore the moon", readyForConfirmation: true }),
    );

    expect(result.nextState).toBe("confirming");
    expect(result.collected.prompt).toBe("A playful dragon and astronaut explore the moon");
    expect(result.collected.blockedPrompt).toBeUndefined();
    expect(result.reply).toMatch(/create it/i);
  });

  it("does not call an unfinished revision declined while its prior failure marker remains", async () => {
    const revised = await advanceComicAgent(
      { state: "collecting", collected: { prompt: IDEA, blockedPrompt: IDEA } },
      { text: "Make the dragon a playful original character", channel: "sms" },
      modelReply({ prompt: "An original playful dragon visits the moon", readyForConfirmation: false }),
    );

    expect(revised.nextState).toBe("collecting");
    expect(revised.collected.blockedPrompt).toBe(IDEA);
    const revisedCurrent = {
      state: revised.nextState,
      collected: revised.collected,
      activeStoryId: revised.activeStoryId,
    };
    const status = await advanceComicAgent(revisedCurrent, { text: "STATUS", channel: "sms" }, modelReply());
    const create = await advanceComicAgent(revisedCurrent, { text: "CREATE", channel: "sms" }, modelReply());
    expect(status.reply).not.toMatch(/declined/i);
    expect(create.reply).not.toMatch(/declined/i);
    expect(status.reply).toMatch(/add or change/i);
    expect(create.action).toBe("none");
  });

  it("tells an MMS sender to resend photos that arrive while a comic is generating", async () => {
    const result = await advanceComicAgent(
      { state: "generating", collected: { prompt: IDEA, characterImageUrls: ["original-photo"] } },
      { text: "NEW", channel: "sms", imageUrls: ["new-photo"] },
      modelReply(),
    );

    expect(result.nextState).toBe("generating");
    expect(result.collected.characterImageUrls).toEqual(["original-photo"]);
    expect(result.reply).toMatch(/resend (?:the|your) photo/i);
    expect(result.reply).toMatch(/after|when.*ready/i);
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
    expect(status.reply).toContain("within 14 days");

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
    expect(reset.collected.prompt).toBeUndefined();
    expect(Number.isFinite(Date.parse(reset.collected.photoHandoffResetAt || ""))).toBe(true);
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
