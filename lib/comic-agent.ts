import { COMIC_STYLES } from "@/lib/constants";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { MAX_USER_PROMPT } from "@/lib/prompt";
import { proposeComicTurn } from "@/lib/comic-agent-model";

export type ComicAgentChannel = "sms" | "whatsapp" | "voice";
export type ComicStyle = (typeof COMIC_STYLES)[number]["id"];
export type AgentMessage = { role: "user" | "assistant"; content: string };

/** The small, serializable draft kept in conversations.collected between turns. */
export interface AgentCollected {
  name?: string; // Legacy conversations can have a name from the old flow.
  prompt?: string;
  style?: string;
  characterImageUrls?: string[];
  targetStoryId?: string;
  generationRequestKey?: string;
  messages?: AgentMessage[];
}

export interface ComicAgentModelInput {
  history: AgentMessage[];
  prompt?: string;
  style?: string;
  name?: string;
  hasReference: boolean;
  targetStoryId?: string;
  channel: ComicAgentChannel;
}

export interface ComicAgentProposal {
  reply: string;
  prompt: string;
  style: ComicStyle;
  readyForConfirmation: boolean;
}

export type ComicAgentModel = (
  input: ComicAgentModelInput,
) => Promise<ComicAgentProposal>;

export interface ComicAgentCurrent {
  state: string;
  collected: AgentCollected;
  activeStoryId?: string | null;
}

export interface ComicAgentTurn {
  text: string;
  channel: ComicAgentChannel;
  imageUrls?: string[];
}

export interface ComicAgentSubmission {
  prompt: string;
  style: string;
  characterImageUrls: string[];
  targetStoryId?: string;
}

export interface ComicAgentResult {
  nextState: "collecting" | "confirming" | "generating" | "done";
  collected: AgentCollected;
  activeStoryId: string | null;
  reply: string;
  action: "none" | "submit";
  submission?: ComicAgentSubmission;
}

const HISTORY_LIMIT = 12;
const REFERENCE_LIMIT = 2;

export function emptyAgentCollected(): AgentCollected {
  return {};
}

function isStyle(value: string | undefined): value is ComicStyle {
  return COMIC_STYLES.some((style) => style.id === value);
}

function styleOrDefault(value: string | undefined): ComicStyle {
  return isStyle(value) ? value : "noir";
}

function approvalInstruction(channel: ComicAgentChannel): string {
  return channel === "voice"
    ? "Say 'create it' when you're ready, or tell me what to change."
    : "Reply CREATE when you're ready, or tell me what to change.";
}

function commandVerb(channel: ComicAgentChannel): "Say" | "Send" {
  return channel === "voice" ? "Say" : "Send";
}

function ideaInvitation(channel: ComicAgentChannel): string {
  return channel === "voice"
    ? "Tell me who the characters are and what happens in your comic."
    : "Tell me what should happen in your comic. You can add up to two character photos.";
}

function normalizedCommand(text: string): string {
  return text.trim().replace(/[.!?,;:…。！？]+$/u, "").trim().toUpperCase();
}

function isApproval(text: string, channel: ComicAgentChannel): boolean {
  const normalized = normalizedCommand(text).toLowerCase();
  if (normalized === "create" || normalized === "create it") return true;
  if (channel !== "voice") return false;
  return /^(?:please )?(?:make it|generate it|go ahead and create it|yes create it)$/.test(
    normalized,
  );
}

function result(
  state: ComicAgentResult["nextState"],
  collected: AgentCollected,
  activeStoryId: string | null,
  reply: string,
): ComicAgentResult {
  return {
    nextState: state,
    collected,
    activeStoryId,
    reply,
    action: "none",
  };
}

function normalizeState(state: string): ComicAgentResult["nextState"] {
  if (state === "confirming" || state === "generating" || state === "done") {
    return state;
  }
  return "collecting"; // Includes old awaiting_name and awaiting_prompt rows.
}

function mergeReferences(current: string[] | undefined, added: string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const url of [...(current || []), ...(added || [])]) {
    if (typeof url === "string" && url.trim()) unique.add(url);
    if (unique.size >= REFERENCE_LIMIT) break;
  }
  return [...unique];
}

function appendMessage(messages: AgentMessage[] | undefined, message: AgentMessage): AgentMessage[] {
  return [...(messages || []), message].slice(-HISTORY_LIMIT);
}

/**
 * Advance one user turn. The model proposes a draft and a reply; the state machine
 * alone decides when a generation job may be submitted.
 */
export async function advanceComicAgent(
  current: ComicAgentCurrent,
  turn: ComicAgentTurn,
  model: ComicAgentModel = proposeComicTurn,
): Promise<ComicAgentResult> {
  const state = normalizeState(current.state);
  const activeStoryId = current.activeStoryId ?? null;
  const existing = current.collected || emptyAgentCollected();
  const text = (turn.text || "").trim();
  const command = normalizedCommand(text);

  // A submitted draft must stay attached to its job until completion. In
  // particular, NEW must not let a late worker overwrite a newer draft.
  if (state === "generating") {
    return result(
      "generating",
      existing,
      activeStoryId,
      `I'm still creating your comic. I'll send it when it's ready. ${commandVerb(turn.channel)} STATUS for an update.`,
    );
  }

  if (command === "STATUS") {
    const reply =
      state === "done"
        ? `Your comic is ready. ${commandVerb(turn.channel)} CONTINUE within ${CONVERSATION_RESUME_DAYS} days to make another page, or NEW for a new story.`
        : state === "confirming"
          ? `Your comic idea is ready. ${approvalInstruction(turn.channel)}`
          : `I'm ready for your comic idea. ${ideaInvitation(turn.channel)}`;
    return result(state, existing, activeStoryId, reply);
  }

  if (["NEW", "RESET", "RESTART"].includes(command)) {
    return result(
      "collecting",
      emptyAgentCollected(),
      null,
      `Let's make a new comic. ${ideaInvitation(turn.channel)}`,
    );
  }

  // CANCEL is a reserved SMS opt-out keyword. Keep it for spoken calls only;
  // messaging users discard a draft with DISCARD.
  if (command === "DISCARD" || (turn.channel === "voice" && command === "CANCEL")) {
    return result(
      activeStoryId ? "done" : "collecting",
      emptyAgentCollected(),
      activeStoryId,
      activeStoryId
        ? `Draft cancelled. ${commandVerb(turn.channel)} CONTINUE within ${CONVERSATION_RESUME_DAYS} days for another page, or NEW for a new story.`
        : "Draft cancelled. Tell me a new comic idea whenever you're ready.",
    );
  }

  if (command === "CONTINUE") {
    if (!activeStoryId) {
      return result(state, existing, null, "There isn't a finished comic to continue yet. Tell me a new idea.");
    }
    return result(
      "collecting",
      {
        targetStoryId: activeStoryId,
        style: isStyle(existing.style) ? existing.style : undefined,
      },
      activeStoryId,
      "What should happen on the next page?",
    );
  }

  if (isApproval(text, turn.channel)) {
    if (state !== "confirming" || !existing.prompt?.trim()) {
      return result(
        state,
        existing,
        activeStoryId,
        "Tell me your comic idea first. I'll summarize it for you to approve.",
      );
    }
    const submission: ComicAgentSubmission = {
      prompt: existing.prompt,
      style: styleOrDefault(existing.style),
      characterImageUrls: mergeReferences(existing.characterImageUrls, turn.imageUrls),
      ...(existing.targetStoryId ? { targetStoryId: existing.targetStoryId } : {}),
    };
    return {
      nextState: "generating",
      collected: { ...existing, characterImageUrls: submission.characterImageUrls },
      activeStoryId,
      reply: "I'm creating your comic now. I'll send the result when it's ready.",
      action: "submit",
      submission,
    };
  }

  if (text.length > MAX_USER_PROMPT) {
    return result(state, existing, activeStoryId, "Please shorten your idea to under 4,000 characters.");
  }

  // A normal new idea after completion starts a new book. CONTINUE is the
  // explicit path that retains the prior story ID for page generation.
  const draft: AgentCollected = state === "done" ? emptyAgentCollected() : { ...existing };
  const draftStoryId = state === "done" ? null : activeStoryId;
  const references = mergeReferences(draft.characterImageUrls, turn.imageUrls);
  if (references.length) draft.characterImageUrls = references;

  if (!text) {
    if (turn.imageUrls?.length) {
      const reply =
        state === "confirming" && draft.prompt
          ? `Photo added to your draft. ${approvalInstruction(turn.channel)}`
          : "Photo received. What's your comic idea?";
      return result(state === "done" ? "collecting" : state, draft, draftStoryId, reply);
    }
    return result(
      state === "done" ? "collecting" : state,
      draft,
      draftStoryId,
      ideaInvitation(turn.channel),
    );
  }

  const history = appendMessage(draft.messages, { role: "user", content: text });
  const proposal = await model({
    history,
    prompt: draft.prompt,
    style: draft.style,
    name: draft.name,
    hasReference: references.length > 0,
    targetStoryId: draft.targetStoryId,
    channel: turn.channel,
  });

  if (!isStyle(proposal.style)) {
    throw new Error("Comic agent returned an unsupported art style");
  }
  if (proposal.prompt.length > MAX_USER_PROMPT) {
    return result(state, existing, activeStoryId, "The comic idea is too long. Please shorten it before we create it.");
  }

  const nextPrompt = proposal.prompt.trim() || draft.prompt;
  const ready = Boolean(proposal.readyForConfirmation && nextPrompt);
  const reply = ready
    ? `${proposal.reply.trim()} ${approvalInstruction(turn.channel)}`.trim()
    : proposal.reply.trim() || "Tell me a little more about your comic idea.";
  return result(
    ready ? "confirming" : "collecting",
    {
      ...draft,
      prompt: nextPrompt,
      style: proposal.style,
      messages: appendMessage(history, { role: "assistant", content: reply }),
    },
    draftStoryId,
    reply,
  );
}
