import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatCreate, moderationCreate } = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  moderationCreate: vi.fn(),
}));

vi.mock("openai", () => {
  function OpenAI() {
    return {
      chat: { completions: { create: chatCreate } },
      moderations: { create: moderationCreate },
    };
  }
  return { default: OpenAI };
});

import { proposeComicTurn } from "@/lib/comic-agent-model";
import { advanceComicAgent } from "@/lib/comic-agent";

const input = {
  history: [{ role: "user" as const, content: "A graphic monster battle" }],
  hasReference: false,
  channel: "sms" as const,
};

function proposal(readyForConfirmation = true) {
  return {
    choices: [{ message: { content: JSON.stringify({
      reply: "A monster battle across five panels. Ready to make it?",
      prompt: "A graphic monster battle",
      style: "noir",
      readyForConfirmation,
    }) } }],
  };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "screening-test-key");
  chatCreate.mockReset().mockResolvedValue(proposal());
  moderationCreate.mockReset().mockResolvedValue({
    results: [{ flagged: false, categories: {} }],
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("comic confirmation screening", () => {
  it("asks for a safer revision before CREATE when the proposed visual is flagged as graphic", async () => {
    moderationCreate.mockResolvedValue({
      results: [{ flagged: true, categories: { "violence/graphic": true, violence: true } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(false);
    expect(result.reply).toMatch(/graphic|gore/i);
    expect(result.reply).toMatch(/change|try|instead/i);
    expect(result.reply).not.toMatch(/\bCREATE\b/i);
  });

  it("keeps a flagged idea out of the approval state across the next CREATE text", async () => {
    moderationCreate.mockResolvedValue({
      results: [{ flagged: true, categories: { "violence/graphic": true } }],
    });

    const screened = await advanceComicAgent(
      { state: "collecting", collected: {}, activeStoryId: null },
      { channel: "sms", text: "A graphic monster battle" },
    );
    expect(screened.nextState).toBe("collecting");
    expect(screened.action).toBe("none");

    const prematureApproval = await advanceComicAgent(
      {
        state: screened.nextState,
        collected: screened.collected,
        activeStoryId: screened.activeStoryId,
      },
      { channel: "sms", text: "CREATE" },
    );
    expect(prematureApproval.nextState).toBe("collecting");
    expect(prematureApproval.action).toBe("none");
    expect(prematureApproval.reply).toMatch(/add or change/i);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps a clear unflagged idea ready for approval", async () => {
    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(true);
    expect(result.reply).toContain("Ready to make it?");
    expect(moderationCreate).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: "A graphic monster battle",
    });
  });

  it("does not screen an idea while the agent is still asking for details", async () => {
    chatCreate.mockResolvedValue(proposal(false));

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(false);
    expect(moderationCreate).not.toHaveBeenCalled();
  });

  it("does not invite approval when the screening service cannot assess the idea", async () => {
    moderationCreate.mockRejectedValue(new Error("Screening service unavailable"));

    await expect(proposeComicTurn(input)).rejects.toThrow("Screening service unavailable");
  });

  it("asks for a new direction when the text model refuses before returning a draft", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: null, refusal: "I cannot help with that request." } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(false);
    expect(result.reply).toMatch(/change|different|revis/i);
    expect(moderationCreate).not.toHaveBeenCalled();
  });
});
