import { createServer } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import next from "next";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { recordVoiceCallStart, recordVoiceTurn } from "@/lib/activity-events";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { advanceComicAgent, emptyAgentCollected } from "@/lib/comic-agent";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { db } from "@/lib/db";
import { getGenerationJobByIdempotencyKey, submitGenerationJob } from "@/lib/generation-jobs";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { conversations, type Conversation } from "@/lib/schema";
import {
  createVoiceRelaySession,
  type VoiceConversationSnapshot,
  type VoiceConversationUpdate,
  type VoiceRelayInbound,
} from "@/lib/voice-conversation";
import { verifyVoiceCallAuthorization } from "@/lib/voice-call-authorization";
import { getConversationRelayUrl } from "@/lib/voice-twiml";

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
  return snapshot(row);
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
      "ADMIN_USERNAME",
      "ADMIN_PASSWORD_HASH",
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
      submit: submitGenerationJob,
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
