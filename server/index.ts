import { createServer } from "node:http";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import next from "next";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { recordVoiceCallStart, recordVoiceTurn } from "@/lib/activity-events";
import { clearStagedCameraPhotoReferences } from "@/lib/browser-photo-staging";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { advanceComicAgent, emptyAgentCollected } from "@/lib/comic-agent";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { db } from "@/lib/db";
import { getGenerationJobByIdempotencyKey, submitGenerationJob } from "@/lib/generation-jobs";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { conversations, twilioInboundMessages, type Conversation } from "@/lib/schema";
import { isTwilioMediaUrl } from "@/lib/twilio";
import {
  createVoiceRelaySession,
  type VoiceConversationSnapshot,
  type VoiceConversationUpdate,
  type VoiceRelayInbound,
} from "@/lib/voice-conversation";
import { verifyVoiceCallAuthorization } from "@/lib/voice-call-authorization";
import { getConversationRelayUrl } from "@/lib/voice-twiml";
import {
  isPhotoOnlySmsStage,
  photoHandoffSourceChannels,
  planConsumedSmsPhotoStage,
  selectVoicePhotoHandoff,
  VOICE_PHOTO_HANDOFF_WINDOW_MS,
  withoutVoicePhotoReferences,
  type VoicePhotoHandoffCandidate,
} from "@/lib/voice-photo-handoff";

function snapshot(row: Conversation): VoiceConversationSnapshot {
  return {
    id: row.id,
    state: row.state,
    collected: row.collected,
    activeStoryId: row.activeStoryId,
    updatedAt: row.updatedAt,
  };
}

const MAX_VOICE_SOCKET_MS = 10 * 60_000;

// The driver exposes timestamps as millisecond-precision Dates. Truncate the
// stored revision too, so a returned Date compares exactly in the next CAS.
const millisecondNow = sql`date_trunc('milliseconds', NOW())`;
const nextRevision = sql`GREATEST(
  date_trunc('milliseconds', NOW()),
  date_trunc('milliseconds', ${conversations.updatedAt}) + INTERVAL '1 millisecond'
)`;

async function loadVoiceConversation(from: string): Promise<VoiceConversationSnapshot> {
  // SET expressions read the old row before updated_at moves forward.
  // Bound access to an inactive draft or story through a possibly reassigned
  // phone number. A generating row keeps its job marker until completion.
  const staleDraft = sql<boolean>`
    ${conversations.updatedAt} < NOW() - (${CONVERSATION_RESUME_DAYS} * INTERVAL '1 day')
    AND ${conversations.state} <> 'generating'
  `;
  const [row] = await db
    .insert(conversations)
    .values({
      phoneNumber: from,
      channel: "voice",
      state: "collecting",
      collected: emptyAgentCollected(),
      updatedAt: millisecondNow,
    })
    .onConflictDoUpdate({
      target: [conversations.channel, conversations.phoneNumber],
      set: {
        state: sql`CASE WHEN ${staleDraft} THEN 'collecting' ELSE ${conversations.state} END`,
        collected: sql`CASE WHEN ${staleDraft} THEN '{}'::jsonb ELSE ${conversations.collected} END`,
        activeStoryId: sql`CASE WHEN ${staleDraft} THEN NULL ELSE ${conversations.activeStoryId} END`,
        updatedAt: nextRevision,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to load voice conversation");

  // Relay setup is reached only after Twilio Verify confirms that this caller
  // receives SMS at the same number. A recent, unfinished photo draft can
  // therefore be handed to Voice without trusting caller ID alone.
  const { voicePhotoMode, cameraEnabled } = await getExperienceSettings();
  const sourceChannels = photoHandoffSourceChannels(voicePhotoMode, cameraEnabled);

  const cutoff = new Date(Date.now() - VOICE_PHOTO_HANDOFF_WINDOW_MS);
  return db.transaction(async (tx) => {
    // Read the latest Voice revision, not the row returned by the earlier
    // upsert: another call could have progressed between those statements.
    const [voice] = await tx.select().from(conversations)
      .where(eq(conversations.id, row.id)).for("update").limit(1);
    if (!voice) throw new Error("Voice conversation disappeared during photo handoff");
    if (voice.state === "generating") return snapshot(voice);
    if (voice.collected.suppressPhotoHandoff && sourceChannels.length > 0) return snapshot(voice);

    if (sourceChannels.length === 0) {
      const cleared = withoutVoicePhotoReferences(snapshot(voice));
      if (!cleared) return snapshot(voice);
      const [updated] = await tx.update(conversations)
        .set({ collected: cleared.collected, updatedAt: nextRevision })
        .where(and(eq(conversations.id, voice.id), eq(conversations.updatedAt, voice.updatedAt)))
        .returning();
      if (!updated) throw new Error("Voice photo preference lost its conversation revision");
      return snapshot(updated);
    }

    const candidates: VoicePhotoHandoffCandidate<Conversation>[] = [];
    for (const sourceChannel of sourceChannels) {
      const [source] = await tx.select().from(conversations)
        .where(and(
          eq(conversations.channel, sourceChannel),
          eq(conversations.phoneNumber, from),
          gte(conversations.updatedAt, cutoff),
        ))
        .for("update")
        .limit(1);
      if (!source) continue;

      const recentSmsMediaUrls = sourceChannel === "sms"
        ? (await tx
          .select({ mediaUrls: twilioInboundMessages.mediaUrls })
          .from(twilioInboundMessages)
          .where(and(
            eq(twilioInboundMessages.channel, "sms"),
            eq(twilioInboundMessages.fromAddress, from),
            gte(twilioInboundMessages.createdAt, cutoff),
            sql`jsonb_array_length(${twilioInboundMessages.mediaUrls}) > 0`,
          ))
          .orderBy(desc(twilioInboundMessages.createdAt))
          .limit(20))
          .flatMap((message) => message.mediaUrls)
        : [];
      candidates.push({ sourceChannel, source, recentSmsMediaUrls });
    }

    // A source already handed to this caller must not hide a fresh stage from
    // the other channel. The first new candidate still follows admin priority.
    const selected = selectVoicePhotoHandoff({
      mode: voicePhotoMode,
      voice: snapshot(voice),
      candidates,
    });
    if (!selected) return snapshot(voice);
    const { handoff, source, sourceChannel } = selected;
    const [updated] = await tx.update(conversations)
      .set({
        state: handoff.state,
        collected: handoff.collected,
        activeStoryId: handoff.activeStoryId,
        updatedAt: nextRevision,
      })
      .where(and(eq(conversations.id, voice.id), eq(conversations.updatedAt, voice.updatedAt)))
      .returning();
    if (!updated) throw new Error("Voice photo handoff lost its conversation revision");

    // Keep a photo-only SMS draft available if the caller hangs up. Once
    // Voice accepts the comic job, the matching stage is consumed below.
    const fingerprint = handoff.collected.photoHandoffFingerprint;
    if (sourceChannel === "sms" && fingerprint && isPhotoOnlySmsStage(source) &&
        source.collected.photoHandoffFingerprint !== fingerprint) {
      await tx.update(conversations)
        .set({
          collected: { ...source.collected, photoHandoffFingerprint: fingerprint },
          updatedAt: nextRevision,
        })
        .where(eq(conversations.id, source.id));
    }
    return snapshot(updated);
  });
}

async function consumeSubmittedVoiceSmsPhotos(
  phone: string,
  submittedReferences: readonly string[],
): Promise<boolean> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || submittedReferences.length === 0) return false;
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(conversations)
      .where(and(eq(conversations.channel, "sms"), eq(conversations.phoneNumber, phone)))
      .for("update")
      .limit(1);
    if (!source) return false;
    // An SMS turn holding this lease may have read the earlier photo draft.
    // Let its checkpoint finish rather than clearing a concurrently used set.
    if (source.leaseOwner && source.leaseExpiresAt && source.leaseExpiresAt > new Date()) {
      return false;
    }
    const collected = planConsumedSmsPhotoStage(source, submittedReferences);
    if (!collected) return false;
    const [updated] = await tx.update(conversations)
      .set({ collected, updatedAt: nextRevision })
      .where(and(eq(conversations.id, source.id), eq(conversations.updatedAt, source.updatedAt)))
      .returning({ id: conversations.id });
    return Boolean(updated);
  });
}

async function saveVoiceConversation(
  previous: VoiceConversationSnapshot,
  update: VoiceConversationUpdate,
): Promise<VoiceConversationSnapshot | null> {
  const [row] = await db
    .update(conversations)
    .set({
      state: update.state,
      collected: update.collected,
      activeStoryId: update.activeStoryId,
      updatedAt: nextRevision,
    })
    .where(and(
      eq(conversations.id, previous.id),
      eq(conversations.updatedAt, previous.updatedAt),
    ))
    .returning();
  return row ? snapshot(row) : null;
}

async function main(): Promise<void> {
  const dev = process.env.NODE_ENV !== "production";
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  const port = Number(process.env.PORT || 8080);
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const voiceNumber = getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS)
    .includes("voice") ? contact.phoneNumber : null;
  const publicWss = voiceNumber ? getConversationRelayUrl() : "";
  if (voiceNumber && !publicWss) {
    throw new Error("CONVERSATION_RELAY_WS_URL must point to the secure /relay endpoint");
  }
  if (process.env.NODE_ENV === "production") {
    const required = [
      "DATABASE_URL",
      "AUTH_SECRET",
      "AZURE_STORAGE_BLOB_ENDPOINT",
      "AZURE_STORAGE_QUEUE_ENDPOINT",
      "AZURE_STORAGE_CONTAINER_NAME",
      "AZURE_STORAGE_QUEUE_NAME",
      "AZURE_CLIENT_ID",
      "MEDIA_SIGNING_SECRET",
      "OPENAI_API_KEY",
      "PUBLIC_BASE_URL",
      ...(voiceNumber ? ["CONVERSATION_RELAY_WS_URL", "TWILIO_VERIFY_SERVICE_SID"] : []),
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
    ].filter((name) => !process.env[name]);
    if (required.length > 0) {
      throw new Error(`Missing required environment variables: ${required.join(", ")}`);
    }
  }
  const app = next({ dev, hostname, port });
  await app.prepare();

  const requestHandler = app.getRequestHandler();
  const nextUpgradeHandler = app.getUpgradeHandler();
  const relay = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  let draining = false;

  function send(ws: WebSocket, value: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  }

  relay.on("connection", (ws) => {
    let voiceUserId: string | null = null;
    async function identity(from: string): Promise<{ userId: string }> {
      const found = await getOrCreateChannelIdentity("voice", from);
      voiceUserId = found.userId;
      return found;
    }
    const session = createVoiceRelaySession({
      expectedAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
      senderAddress: voiceNumber || "",
      authorizeCall: ({ authorization, callSid, from, to }) =>
        verifyVoiceCallAuthorization(
          authorization,
          { callSid, from, to },
          process.env.AUTH_SECRET,
        ),
      load: loadVoiceConversation,
      save: saveVoiceConversation,
      advance: advanceComicAgent,
      identity,
      submit: async (input) => {
        const submission = await submitGenerationJob(input);
        if (submission.accepted) {
          const smsReferences = input.characterImageUrls.filter(isTwilioMediaUrl);
          if (smsReferences.length) {
            try {
              await consumeSubmittedVoiceSmsPhotos(input.recipientAddress, smsReferences);
            } catch (error) {
              console.error("Voice SMS photo stage cleanup failed", error instanceof Error ? error.name : "unknown");
            }
          }
          const cameraReferences = input.characterImageUrls.filter((reference) =>
            reference.startsWith("blob:uploads/"));
          if (cameraReferences.length) {
            try {
              // The conditional clear leaves any kiosk photos uploaded after
              // this call's handoff ready for the next comic.
              await clearStagedCameraPhotoReferences(input.recipientAddress, cameraReferences);
            } catch (error) {
              // The job is queued with its own saved references. A cleanup
              // failure must not turn an accepted comic into a retry prompt.
              console.error("Voice camera stage cleanup failed", error instanceof Error ? error.name : "unknown");
            }
          }
        }
        return submission;
      },
      lookupJob: getGenerationJobByIdempotencyKey,
      onCallStart: async ({ callSid, from, to }) => {
        try {
          await identity(from);
        } catch (error) {
          console.error("Voice caller identity lookup failed", error);
        }
        await recordVoiceCallStart({
          callSid,
          fromAddress: from,
          toAddress: to,
          userId: voiceUserId,
        });
      },
      onTurn: ({ callSid, from, sequence, role, content }) => recordVoiceTurn({
        callSid,
        address: from,
        userId: voiceUserId,
        sequence,
        role,
        content,
      }),
      onError: (context, error) => console.error(context, error),
    });
    let chain = Promise.resolve();
    let deadlineReached = false;
    let limitSent = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    function finishTimeout(): void {
      if (limitSent || ws.readyState !== WebSocket.OPEN) return;
      const outbound = session.timeout();
      if (outbound.length === 0) return;
      limitSent = true;
      for (const event of outbound) send(ws, event);
      // ConversationRelay should return to the signed action callback on
      // `end`; close a stuck socket if it has not done so a few seconds later.
      closeTimer = setTimeout(() => ws.close(1000, "Session limit reached"), 5_000);
      closeTimer.unref();
    }

    const sessionTimer = setTimeout(() => {
      deadlineReached = true;
      // A prompt may be saving its checkpoint or submitting a job. Defer the
      // limit handoff until it can report queued/checking or finish safely.
      finishTimeout();
      chain = chain.then(finishTimeout);
    }, MAX_VOICE_SOCKET_MS);
    sessionTimer.unref();

    ws.on("error", (error) => console.error("ConversationRelay socket error", error));
    ws.on("close", () => {
      clearTimeout(sessionTimer);
      if (closeTimer) clearTimeout(closeTimer);
      session.close();
    });
    ws.on("message", (raw) => {
      if (deadlineReached) return;
      const receivedAt = Date.now();
      chain = chain.then(async () => {
        if (deadlineReached) return;
        let message: VoiceRelayInbound & { description?: string };
        try {
          const parsed: unknown = JSON.parse(raw.toString());
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          message = parsed as VoiceRelayInbound & { description?: string };
        } catch {
          return;
        }
        if (message.type === "error") {
          console.error("ConversationRelay upstream error", message.description?.slice(0, 200));
        }
        for (const outbound of await session.handle(message, receivedAt)) {
          send(ws, outbound);
        }
      }).catch((error) => {
        console.error("ConversationRelay dispatch failed", error);
        session.close();
        send(ws, { type: "end", handoffData: JSON.stringify({ result: "service_error" }) });
      });
    });
  });

  const server = createServer((request, response) => {
    void requestHandler(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    if (draining) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const incomingUrl = new URL(request.url || "/", "http://localhost");
    if (incomingUrl.pathname !== "/relay") {
      void nextUpgradeHandler(request, socket, head);
      return;
    }

    if (!voiceNumber) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const signature = request.headers["x-twilio-signature"];
    const valid =
      publicWss &&
      incomingUrl.search === new URL(publicWss).search &&
      typeof signature === "string" &&
      twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN || "",
        signature,
        publicWss,
        {},
      );
    if (!valid) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    relay.handleUpgrade(request, socket, head, (ws) => {
      relay.emit("connection", ws, request);
    });
  });

  server.listen(port, hostname, () => {
    console.log(`twilio-comics listening on http://${hostname}:${port}`);
  });

  function shutdown(): void {
    draining = true;
    server.close();
    // ACA gives the previous revision 240 seconds to drain during a rollout.
    // Leave ten seconds for socket close frames and process termination.
    setTimeout(() => {
      for (const client of relay.clients) {
        client.close(1012, "Service restarting");
      }
      process.exit(0);
    }, 230_000).unref();
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((error) => {
  console.error("Failed to start twilio-comics", error);
  process.exitCode = 1;
});
