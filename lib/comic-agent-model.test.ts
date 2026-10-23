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
      reply: "A dark fantasy comic about a monster battle.",
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
    expect(result.reply).toBe("A dark fantasy comic about a monster battle.");
    expect(moderationCreate).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: "A graphic monster battle",
    });
  });

  it("instructs the model to keep the confirmation high level and leave CREATE to the app", async () => {
    await proposeComicTurn(input);

    const request = chatCreate.mock.calls[0]?.[0];
    const systemPrompt = request?.messages?.[0]?.content;
    expect(systemPrompt).toMatch(/summarize only the broad premise and tone/i);
    expect(systemPrompt).toMatch(/Never mention the number of panels/i);
    expect(systemPrompt).toMatch(/Do not reveal a storyboard or spoil/i);
    expect(systemPrompt).toMatch(/application adds the CREATE approval instruction separately/i);
  });

  it("keeps an accidental panel plan out of an otherwise ready confirmation", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "Panel 1 shows the monster. Panel 2 shows the battle. Confirm these panels?",
        prompt: "A dramatic monster battle in a dark fantasy city",
        style: "noir",
        readyForConfirmation: true,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(true);
    expect(result.reply).toBe("A dramatic monster battle in a dark fantasy city.");
    expect(result.reply).not.toMatch(/panel|CREATE/i);
    expect(moderationCreate).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: "A dramatic monster battle in a dark fantasy city",
    });
  });

  it("does not confirm numbered scenes or shots before generation", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "Scene 1: the detective finds a key. Shot 2: the culprit appears. Does that work?",
        prompt: "A noir mystery about a detective and a mysterious key",
        style: "noir",
        readyForConfirmation: true,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(true);
    expect(result.reply).toBe("A noir mystery about a detective and a mysterious key.");
    expect(result.reply).not.toMatch(/scene|shot|culprit/i);
  });

  it("does not ask for details about a final scene while gathering the idea", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "What should happen in the final scene?",
        prompt: "A detective investigates a strange clock",
        style: "noir",
        readyForConfirmation: false,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(false);
    expect(result.reply).toBe("What's the main idea for your comic?");
    expect(moderationCreate).not.toHaveBeenCalled();
  });

  it("does not repeat an approval command supplied by the model", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "A noir detective comedy. Reply CREATE to make it.",
        prompt: "A noir detective comedy",
        style: "noir",
        readyForConfirmation: true,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.reply).toBe("A noir detective comedy.");
    expect(result.reply).not.toContain("CREATE");
  });

  it("keeps useful safety guidance while removing a panel reference", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "This panel may be too graphic. Try action without gore instead.",
        prompt: "A monster battle without gore",
        style: "noir",
        readyForConfirmation: false,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.readyForConfirmation).toBe(false);
    expect(result.reply).toBe("This scene may be too graphic. Try action without gore instead.");
    expect(moderationCreate).not.toHaveBeenCalled();
  });

  it("drops a numbered panel description but retains the revision", async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        reply: "Panel 1 shows a graphic battle. Try an action story without gore instead.",
        prompt: "A monster battle without gore",
        style: "noir",
        readyForConfirmation: false,
      }) } }],
    });

    const result = await proposeComicTurn(input);

    expect(result.reply).toBe("Try an action story without gore instead.");
    expect(result.reply).not.toMatch(/panel|graphic battle/i);
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
