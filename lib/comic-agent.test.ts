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
  it("saves an initial comic idea and asks for a photo before approval", async () => {
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
    expect(result.reply).toMatch(/sound right\?\n\nSend at least one character photo/);
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

  it("does not discard a verified caller's staged photos on a skip command", async () => {
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
      characterImageUrls: ["https://example.com/first"],
      photoHandoffFingerprint: "same-source",
    });
    expect(result.collected.suppressPhotoHandoff).not.toBe(true);
    expect(result.reply).toMatch(/reference photo.*required/i);
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

  it.each(["NEW", "RESET", "RESTART"])(
    "queues %s during generation without detaching the running job",
    async (text) => {
      const result = await advanceComicAgent(
        {
          state: "generating",
          activeStoryId: "story-1",
          collected: {
            prompt: IDEA,
            style: "manga",
            characterImageUrls: ["old-photo"],
            generationRequestKey: "twilio-message:SM-old",
          },
        },
        { text, channel: "sms", imageUrls: ["new-photo"] },
        modelReply(),
      );

      expect(result.nextState).toBe("generating");
      expect(result.freshStart).toBe(true);
      expect(result.activeStoryId).toBe("story-1");
      expect(result.collected).toMatchObject({
        prompt: IDEA,
        characterImageUrls: ["old-photo"],
        generationRequestKey: "twilio-message:SM-old",
      });
      expect(Date.parse(result.collected.newDraftRequestedAt || "")).not.toBeNaN();
      expect(result.reply).toMatch(/new comic|start over/i);
      expect(result.reply).toMatch(/after.*result/i);
      expect(result.reply).toMatch(/one or two.*photo/i);
      expect(result.reply).toMatch(/resend.*photo/i);
    },
  );

  it("keeps DISCARD locked during generation", async () => {
    const result = await advanceComicAgent(
      { state: "generating", collected: { prompt: IDEA, style: "manga" } },
      { text: "DISCARD", channel: "sms" },
      modelReply(),
    );
    expect(result.nextState).toBe("generating");
    expect(result.collected.prompt).toBe(IDEA);
    expect(result.freshStart).toBeUndefined();
    expect(result.collected.newDraftRequestedAt).toBeUndefined();
    expect(result.reply).toMatch(/working|creating|generat/i);
  });

  it("reminds a Voice caller that a queued NEW needs fresh photos after the current result", async () => {
    const result = await advanceComicAgent(
      {
        state: "generating",
        collected: { prompt: IDEA, generationRequestKey: "twilio-call:old" },
      },
      { text: "NEW", channel: "voice" },
      modelReply(),
    );

    expect(result.nextState).toBe("generating");
    expect(result.reply).toMatch(/after.*result.*text.*photo.*call back/is);
  });

  it("reports the queued new comic when STATUS arrives before the old job finishes", async () => {
    const result = await advanceComicAgent(
      {
        state: "generating",
        collected: {
          prompt: IDEA,
          generationRequestKey: "twilio-message:SM-old",
          newDraftRequestedAt: "2026-10-01T00:00:01.000Z",
        },
      },
      { text: "STATUS", channel: "sms" },
      modelReply(),
    );

    expect(result.reply).toMatch(/new comic.*after.*result/is);
    expect(result.reply).toMatch(/photo/i);
  });

  it.each(["sms", "whatsapp", "voice"] as const)(
    "starts a fresh %s comic by asking for a reference photo",
    async (channel) => {
      const result = await advanceComicAgent(
        {
          state: "done",
          activeStoryId: "story-1",
          collected: { prompt: IDEA, characterImageUrls: ["old-photo"] },
        },
        { text: "NEW", channel },
        modelReply(),
      );

      expect(result.nextState).toBe("collecting");
      expect(result.freshStart).toBe(true);
      expect(result.activeStoryId).toBeNull();
      expect(result.collected.characterImageUrls).toBeUndefined();
      expect(result.collected.prompt).toBeUndefined();
      expect(result.reply).toMatch(/photo/i);
      if (channel === "voice") {
        expect(result.reply).toMatch(/text.*new reference photo.*call back/i);
      }
      else expect(result.reply).toMatch(/send.*photo/i);
    },
  );

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
    expect(result.reply).toMatch(/reference photo/i);
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
      freshStart: true,
    });
  });

  it("uses a spoken approval phrase for voice calls", async () => {
    const result = await advanceComicAgent(
      {
        state: "confirming",
        collected: { prompt: IDEA, style: "noir", characterImageUrls: ["portrait-1"] },
      },
      { text: "create it", channel: "voice" },
      modelReply(),
    );
    expect(result.action).toBe("submit");
    expect(result.submission?.prompt).toBe(IDEA);
    expect(result.submission?.characterImageUrls).toEqual(["portrait-1"]);
  });

  it("tells a Voice caller whether a reference is present before approval", async () => {
    const withoutPhotos = await advanceComicAgent(
      { state: "collecting", collected: emptyAgentCollected() },
      { text: IDEA, channel: "voice" },
      modelReply(),
    );
    expect(withoutPhotos.nextState).toBe("confirming");
    expect(withoutPhotos.reply).toMatch(/no reference photos/i);
    expect(withoutPhotos.reply).toMatch(/hang up.*photo setup.*call back/i);
    expect(withoutPhotos.reply).not.toMatch(/create it/i);

    const withPhotos = await advanceComicAgent(
      { state: "collecting", collected: { characterImageUrls: ["portrait-1"] } },
      { text: IDEA, channel: "voice" },
      modelReply(),
    );
    expect(withPhotos.nextState).toBe("confirming");
    expect(withPhotos.reply).toMatch(/one reference photo/i);
    expect(withPhotos.reply).toMatch(/create it/i);
  });

  it("does not submit a new Voice comic without photos on ordinary approval", async () => {
    const result = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "noir" } },
      { text: "create it", channel: "voice" },
      modelReply(),
    );

    expect(result.action).toBe("none");
    expect(result.nextState).toBe("confirming");
    expect(result.submission).toBeUndefined();
    expect(result.reply).toMatch(/no reference photos/i);
    expect(result.reply).toMatch(/hang up.*photo setup.*call back/i);
  });

  it("does not let a Voice skip command bypass the photo requirement", async () => {
    const skipped = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "noir" } },
      { text: "skip photos", channel: "voice" },
      modelReply(),
    );
    const approved = await advanceComicAgent(
      { state: skipped.nextState, collected: skipped.collected },
      { text: "create it", channel: "voice" },
      modelReply(),
    );

    expect(skipped.collected.suppressPhotoHandoff).not.toBe(true);
    expect(skipped.reply).toMatch(/reference photo.*required/i);
    expect(approved.action).toBe("none");
    expect(approved.submission).toBeUndefined();
  });

  it.each(["sms", "whatsapp"] as const)(
    "requires a reference photo before a new %s comic can be created",
    async (channel) => {
      const draft = await advanceComicAgent(
        { state: "collecting", collected: emptyAgentCollected() },
        { text: IDEA, channel },
        modelReply(),
      );
      expect(draft.nextState).toBe("confirming");
      expect(draft.reply).toMatch(/send at least one.*photo/i);
      expect(draft.reply).not.toMatch(/reply CREATE/i);

      const approval = await advanceComicAgent(
        { state: draft.nextState, collected: draft.collected },
        { text: "CREATE", channel },
        modelReply(),
      );
      expect(approval.action).toBe("none");
      expect(approval.nextState).toBe("confirming");
      expect(approval.submission).toBeUndefined();
      expect(approval.reply).toMatch(/send at least one.*photo/i);
    },
  );

  it("allows an SMS caller to add a reference to a saved idea before approval", async () => {
    const added = await advanceComicAgent(
      { state: "confirming", collected: { prompt: IDEA, style: "noir" } },
      { text: "", channel: "sms", imageUrls: ["portrait-1"] },
      modelReply(),
    );
    const approved = await advanceComicAgent(
      { state: added.nextState, collected: added.collected },
      { text: "CREATE", channel: "sms" },
      modelReply(),
    );

    expect(added.reply).toMatch(/reply CREATE/i);
    expect(approved.action).toBe("submit");
    expect(approved.submission?.characterImageUrls).toEqual(["portrait-1"]);
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
    expect(generating.reply).toMatch(/still creating.*send it when it's ready/i);
    expect(generating.reply).not.toMatch(/say STATUS/i);

    const done = await advanceComicAgent(
      { state: "done", collected: { prompt: IDEA }, activeStoryId: "story-1" },
      { text: "status", channel: "voice" },
      modelReply(),
    );
    expect(done.reply).toContain("Say CONTINUE");
  });

  it.each(["STATUS", "NEW", ""])("guides Voice callers to add a required photo for %j", async (text) => {
    const model = modelReply();
    const response = await advanceComicAgent(
      { state: "collecting", collected: emptyAgentCollected() },
      { text, channel: "voice" },
      model,
    );

    expect(response.reply).toMatch(/comic|idea/i);
    expect(response.reply).toMatch(/character|happen/i);
    expect(response.reply).toMatch(/reference photo/i);
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
