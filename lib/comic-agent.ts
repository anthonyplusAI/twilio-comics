import { COMIC_STYLES } from "@/lib/constants";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { COMIC_START_MESSAGE } from "@/lib/marketing-contact";
import { MAX_USER_PROMPT } from "@/lib/prompt";
import { proposeComicTurn } from "@/lib/comic-agent-model";

export type ComicAgentChannel = "sms" | "whatsapp" | "voice";
export type ComicStyle = (typeof COMIC_STYLES)[number]["id"];
export type AgentMessage = { role: "user" | "assistant"; content: string };

/** The small, serializable draft kept in conversations.collected between turns. */
export interface AgentCollected {
  name?: string; // Legacy conversations can have a name from the old flow.
  prompt?: string;
  blockedPrompt?: string;
  style?: string;
  characterImageUrls?: string[];
  /** Camera staging timestamps keyed by reference, used to honor NEW cutoffs. */
  cameraReferenceSavedAt?: Record<string, number>;
  photoHandoffFingerprint?: string;
  photoHandoffResetAt?: string;
  ignoredCameraReferences?: string[];
  suppressPhotoHandoff?: boolean;
  targetStoryId?: string;
  generationRequestKey?: string;
  newDraftRequestedAt?: string;
  phoneRestartedAt?: string;
  phoneRestartedByMessageSid?: string;
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
  freshStart?: true;
  submission?: ComicAgentSubmission;
}

const HISTORY_LIMIT = 12;
const REFERENCE_LIMIT = 2;

export function emptyAgentCollected(): AgentCollected {
  return {};
}

function freshAgentCollected(existing: AgentCollected, channel: ComicAgentChannel): AgentCollected {
  // The fingerprint dismisses the last set handed to Voice. The reset time
  // also dismisses other photo stages that were already waiting at a booth
  // or in SMS before this caller asked to start over.
  return channel === "voice"
    ? {
        ...(existing.photoHandoffFingerprint
          ? { photoHandoffFingerprint: existing.photoHandoffFingerprint }
          : {}),
        ...(existing.ignoredCameraReferences?.length
          ? { ignoredCameraReferences: existing.ignoredCameraReferences }
          : {}),
        photoHandoffResetAt: new Date().toISOString(),
      }
    : emptyAgentCollected();
}

function isStyle(value: string | undefined): value is ComicStyle {
  return COMIC_STYLES.some((style) => style.id === value);
}

function styleOrDefault(value: string | undefined): ComicStyle {
  return isStyle(value) ? value : "noir";
}

function approvalInstruction(channel: ComicAgentChannel, collected: AgentCollected): string {
  if (collected.targetStoryId) {
    return channel === "voice"
      ? "I can use your previous comic page as a reference. Say 'create it' when you're ready, or tell me what to change."
      : "Reply CREATE when you're ready, or tell me what to change.";
  }
  const referenceCount = mergeReferences(collected.characterImageUrls, undefined).length;
  if (referenceCount === 0) {
    return channel === "voice"
      ? "I have no reference photos for this call. Hang up and text one or two photos to this number from the phone you're calling on. Wait for the Photo saved reply, then call back. Your idea is saved."
      : "Send at least one character photo before replying CREATE. Your idea is saved.";
  }
  return channel === "voice"
    ? `I have ${referenceCount === 1 ? "one reference photo" : "two reference photos"}. Say 'create it' when you're ready, or tell me what to change.`
    : "Reply CREATE when you're ready, or tell me what to change.";
}

function withInstruction(message: string, instruction: string, channel: ComicAgentChannel): string {
  return `${message.trim()}${channel === "voice" ? " " : "\n\n"}${instruction}`;
}

function commandVerb(channel: ComicAgentChannel): "Say" | "Reply" {
  return channel === "voice" ? "Say" : "Reply";
}

function ideaInvitation(channel: ComicAgentChannel): string {
  return channel === "voice"
    ? "Tell me who the characters are and what happens in your comic. A reference photo is required before I can create it."
    : "Tell me what should happen in your comic. Send one or two character photos before CREATE.";
}

function freshPhotoInvitation(channel: ComicAgentChannel): string {
  return channel === "voice"
    ? "Hang up, text one or two new reference photos to this number, then call back from the same number and tell me who the characters are and what happens in your comic."
    : "Send one or two photos of yourself or your characters as fresh references, then tell me your comic idea.";
}

function queuedPhotoInvitation(channel: ComicAgentChannel): string {
  return channel === "voice"
    ? "After the current result text, hang up and text one or two new reference photos to this number, then call back from the same number with your idea."
    : "After the current result message, send one or two new reference photos, then your idea.";
}

function normalizedCommand(text: string): string {
  return text.trim().replace(/[.!?,;:…。！？]+$/u, "").trim().toUpperCase();
}

function sameDraftPrompt(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return normalize(left) === normalize(right);
}

function isCurrentBlockedPrompt(collected: AgentCollected): boolean {
  return Boolean(collected.prompt?.trim() && collected.blockedPrompt &&
    sameDraftPrompt(collected.prompt, collected.blockedPrompt));
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
  freshStart = false,
): ComicAgentResult {
  return {
    nextState: state,
    collected,
    activeStoryId,
    reply,
    action: "none",
    ...(freshStart ? { freshStart: true as const } : {}),
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
  let existing = current.collected || emptyAgentCollected();
  const text = (turn.text || "").trim();
  const command = normalizedCommand(text);

  // A submitted draft stays attached to its job until completion. A fresh
  // start is recorded on that draft so its terminal job can clear it safely.
  if (state === "generating") {
    if (["NEW", "RESET", "RESTART"].includes(command)) {
      const photoNotice = turn.channel !== "voice" && turn.imageUrls?.length
        ? ` Please resend your ${turn.imageUrls.length === 1 ? "photo" : "photos"} afterward; I can't save it yet.`
        : "";
      return result(
        "generating",
        { ...existing, newDraftRequestedAt: new Date().toISOString() },
        activeStoryId,
        `I've queued a new comic. ${queuedPhotoInvitation(turn.channel)}${photoNotice}`,
        true,
      );
    }
    if (command === "STATUS") {
      return result(
        "generating",
        existing,
        activeStoryId,
        existing.newDraftRequestedAt
          ? `Your new comic will start after the current result message. ${queuedPhotoInvitation(turn.channel)}`
          : "I'm still creating your comic. I'll send it when it's ready.",
      );
    }
    const photoNotice = turn.channel !== "voice" && turn.imageUrls?.length
      ? ` Please resend your ${turn.imageUrls.length === 1 ? "photo" : "photos"} afterward; I can't save it yet.`
      : "";
    if (existing.newDraftRequestedAt) {
      return result(
        "generating",
        existing,
        activeStoryId,
        `Your new comic will start after the current result message. ${queuedPhotoInvitation(turn.channel)}${photoNotice}`,
      );
    }
    return result(
      "generating",
      existing,
      activeStoryId,
      withInstruction(
        `I'm still creating your comic. I'll send it when it's ready.${photoNotice}`,
        `${commandVerb(turn.channel)} STATUS for an update.`,
        turn.channel,
      ),
    );
  }

  if (command === "STATUS") {
    const reply =
      state === "done"
        ? withInstruction(
            "Your comic is ready.",
            `${commandVerb(turn.channel)} CONTINUE within ${CONVERSATION_RESUME_DAYS} days to make another page, or NEW for a new story.`,
            turn.channel,
          )
        : state === "confirming"
          ? withInstruction("Your comic idea is ready.", approvalInstruction(turn.channel, existing), turn.channel)
          : existing.prompt?.trim()
            ? isCurrentBlockedPrompt(existing)
              ? "The image service declined this idea. Tell me what to change before we try again."
              : "I have your idea. Tell me what to add or change."
            : `I'm ready for your comic idea. ${ideaInvitation(turn.channel)}`;
    return result(state, existing, activeStoryId, reply);
  }

  // A photo-only SMS draft remains available after its photos are handed to
  // Voice. The next distinct MMS starts a new set instead of silently hitting
  // the two-photo limit; a text idea can still finish the original SMS draft.
  if (turn.channel === "sms" && state === "collecting" &&
      existing.photoHandoffFingerprint && !existing.prompt?.trim() &&
      (!Array.isArray(existing.messages) || existing.messages.length === 0) &&
      turn.imageUrls?.some((url) => !existing.characterImageUrls?.includes(url))) {
    existing = { ...existing, characterImageUrls: [], photoHandoffFingerprint: undefined };
  }

  // The public text link suggests a friendly opening message. It is an
  // invitation, not a reset command: tapping the link again must not erase
  // photos or an idea already collected from this phone.
  if (turn.channel !== "voice" && command === normalizedCommand(COMIC_START_MESSAGE)) {
    const startingFresh = state === "done";
    const draft = startingFresh ? emptyAgentCollected() : { ...existing };
    const previousReferences = Array.isArray(draft.characterImageUrls) ? draft.characterImageUrls : [];
    const references = mergeReferences(draft.characterImageUrls, turn.imageUrls);
    if (references.length) draft.characterImageUrls = references;
    const newPhotoRetained = turn.imageUrls?.some((url) =>
      references.includes(url) && !previousReferences.includes(url)) ?? false;
    const reply = draft.prompt?.trim()
      ? state === "confirming"
        ? withInstruction("Your idea is ready.", approvalInstruction(turn.channel, draft), turn.channel)
        : "I have your idea. Tell me what to add, or send a photo."
      : references.length
        ? turn.imageUrls?.length && !newPhotoRetained
          ? "I can use up to two photos. Tell me your comic idea.\n\nSend NEW for a fresh set."
          : `${newPhotoRetained ? "Photo saved." : "I have your photos."} Tell me what should happen in your comic.`
        : "Send 1 or 2 photos of yourself or a character, then text your comic idea.";
    return result(startingFresh ? "collecting" : state, draft, startingFresh ? null : activeStoryId, reply);
  }

  if (turn.channel === "voice" && ["SKIP PHOTOS", "WITHOUT PHOTOS", "NO PHOTOS"].includes(command)) {
    return result(
      state,
      existing,
      activeStoryId,
      existing.targetStoryId
        ? "I can use your previous comic page as a reference. Tell me what to change, or say create it when you're ready."
        : existing.characterImageUrls?.length
          ? "A reference photo is required. Your saved photos are still attached. To replace them, hang up and text one or two photos to this number from the phone you're calling on, then call back. Your idea is saved."
          : "A reference photo is required. Hang up and text one or two photos to this number from the phone you're calling on, then call back. Your idea is saved.",
    );
  }

  if (["NEW", "RESET", "RESTART"].includes(command)) {
    const fresh = freshAgentCollected(existing, turn.channel);
    const references = mergeReferences(undefined, turn.imageUrls);
    if (references.length) fresh.characterImageUrls = references;
    const photoReply = references.length
      ? turn.imageUrls && turn.imageUrls.length > references.length
        ? "I saved the first two photos. "
        : `${references.length === 1 ? "Photo" : "Photos"} saved. `
      : "";
    return result(
      "collecting",
      fresh,
      null,
      `Let's make a new comic. ${photoReply}${references.length && turn.channel !== "voice"
        ? "Tell me your comic idea."
        : freshPhotoInvitation(turn.channel)}`,
      true,
    );
  }

  // CANCEL is a reserved SMS opt-out keyword. Keep it for spoken calls only;
  // messaging users discard a draft with DISCARD.
  if (command === "DISCARD" || (turn.channel === "voice" && command === "CANCEL")) {
    return result(
      activeStoryId ? "done" : "collecting",
      freshAgentCollected(existing, turn.channel),
      activeStoryId,
      activeStoryId
        ? withInstruction(
            "Draft cancelled.",
            `${commandVerb(turn.channel)} CONTINUE within ${CONVERSATION_RESUME_DAYS} days for another page, or NEW for a new story.`,
            turn.channel,
          )
        : "Draft cancelled. Tell me a new comic idea whenever you're ready.",
      turn.channel === "voice",
    );
  }

  if (command === "CONTINUE") {
    if (!activeStoryId) {
      return result(state, existing, null, "There isn't a finished comic to continue yet. Tell me a new idea.");
    }
    return result(
      "collecting",
      {
        ...freshAgentCollected(existing, turn.channel),
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
        existing.prompt?.trim()
          ? isCurrentBlockedPrompt(existing)
            ? "The image service declined this idea. Tell me what to change before we try again."
            : "Tell me what to add or change first. I'll summarize the revised idea for approval."
          : "Tell me your comic idea first. I'll summarize it for you to approve.",
      );
    }
    const references = mergeReferences(existing.characterImageUrls, turn.imageUrls);
    if (!existing.targetStoryId && references.length === 0) {
      return result(
        "confirming",
        existing,
        activeStoryId,
        approvalInstruction(turn.channel, existing),
      );
    }
    const submission: ComicAgentSubmission = {
      prompt: existing.prompt,
      style: styleOrDefault(existing.style),
      characterImageUrls: references,
      ...(existing.targetStoryId ? { targetStoryId: existing.targetStoryId } : {}),
    };
    return {
      nextState: "generating",
      collected: { ...existing, characterImageUrls: submission.characterImageUrls },
      activeStoryId,
      reply: turn.channel === "voice"
        ? "I'm creating your comic now. I'll text the link when it's ready."
        : turn.channel === "whatsapp"
          ? "I'm creating your comic now. I'll message the link here. Reply STATUS if it doesn't arrive."
          : "I'm creating your comic now. I'll text the link here. Reply STATUS if it doesn't arrive.",
      action: "submit",
      submission,
    };
  }

  if (text.length > MAX_USER_PROMPT) {
    return result(state, existing, activeStoryId, "Please shorten your idea to under 4,000 characters.");
  }

  // A normal new idea after completion starts a new book. CONTINUE is the
  // explicit path that retains the prior story ID for page generation.
  const draft: AgentCollected = state === "done"
    ? freshAgentCollected(existing, turn.channel)
    : { ...existing };
  const draftStoryId = state === "done" ? null : activeStoryId;
  const previousReferences = Array.isArray(draft.characterImageUrls) ? draft.characterImageUrls : [];
  const references = mergeReferences(draft.characterImageUrls, turn.imageUrls);
  if (references.length) draft.characterImageUrls = references;

  if (!text) {
    if (turn.imageUrls?.length) {
      const newPhotoRetained = turn.imageUrls.some((url) =>
        references.includes(url) && !previousReferences.includes(url));
      const reply =
        state === "confirming" && draft.prompt
          ? withInstruction(
              newPhotoRetained ? "Photo added to your draft." : "I can use up to two photos.",
              approvalInstruction(turn.channel, draft),
              turn.channel,
            )
          : newPhotoRetained
            ? "Photo saved. What's your comic idea?"
            : "I can use up to two photos. Tell me your idea.\n\nSend NEW for a fresh set.";
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
  const stillBlocked = Boolean(draft.blockedPrompt && nextPrompt &&
    sameDraftPrompt(nextPrompt, draft.blockedPrompt));
  const ready = Boolean(proposal.readyForConfirmation && nextPrompt && !stillBlocked);
  const reply = stillBlocked
    ? "The image service declined this idea. Tell me what to change before we try again."
    : ready
      ? withInstruction(proposal.reply, approvalInstruction(turn.channel, draft), turn.channel)
      : proposal.reply.trim() || "Tell me a little more about your comic idea.";
  if (ready) delete draft.blockedPrompt;
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
