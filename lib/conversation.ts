export type ConversationState = "awaiting_name" | "awaiting_prompt" | "generating" | "done";

export interface Collected {
  name?: string;
  prompt?: string;
  style?: string;
  characterImageUrls?: string[];
}

export interface InboundTurn {
  body: string;
  hasImage: boolean;
}

export interface Advance {
  nextState: ConversationState;
  collected: Collected;
  reply: string;
  action: "none" | "enqueue_generation" | "reset";
}

const RESET_KEYWORDS = new Set(["new", "restart", "reset"]);
const WELCOME = "Welcome to Twilio Comics! What's your name?";

export function advanceConversation(
  current: { state: ConversationState; collected: Collected },
  turn: InboundTurn,
): Advance {
  const body = (turn.body || "").trim();

  // Global reset keyword
  if (RESET_KEYWORDS.has(body.toLowerCase())) {
    return { nextState: "awaiting_name", collected: {}, reply: WELCOME, action: "reset" };
  }

  switch (current.state) {
    case "awaiting_name": {
      if (!body) {
        return { nextState: "awaiting_name", collected: current.collected, reply: WELCOME, action: "none" };
      }
      const collected = { ...current.collected, name: body };
      return {
        nextState: "awaiting_prompt",
        collected,
        reply: `Nice to meet you, ${body}! Describe the comic you want — a scene, characters, a vibe. (You can also attach a photo to star in it.)`,
        action: "none",
      };
    }
    case "awaiting_prompt": {
      if (!body) {
        return {
          nextState: "awaiting_prompt",
          collected: current.collected,
          reply: "Tell me what the comic should be about — the more detail, the better!",
          action: "none",
        };
      }
      const collected = { ...current.collected, prompt: body };
      const name = collected.name ? `, ${collected.name}` : "";
      return {
        nextState: "generating",
        collected,
        reply: `Got it${name}! Generating your comic now — this takes about a minute. I'll send it when it's ready.`,
        action: "enqueue_generation",
      };
    }
    case "generating": {
      return {
        nextState: "generating",
        collected: current.collected,
        reply: "Still drawing your last comic — hang tight, it'll arrive shortly! (Text 'new' to start over.)",
        action: "none",
      };
    }
    case "done":
    default: {
      return { nextState: "awaiting_name", collected: {}, reply: WELCOME, action: "reset" };
    }
  }
}
