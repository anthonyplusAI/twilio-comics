import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import {
  deleteInboundMessage,
  deleteGenerationJob,
  receiveInboundMessage,
  receiveGenerationJob,
  renewInboundMessage,
  renewGenerationJob,
  verifyInboundQueueAccess,
} from "@/lib/generation-queue";
import {
  ConversationLeaseBusyError,
  EarlierInboundTurnsPendingError,
  processInboundMessage,
} from "@/lib/process-inbound-message";
import { recoverUnpublishedGenerationJobs } from "@/lib/generation-jobs";
import { recoverPendingInboundMessages, recoverStalledAgentReplies } from "@/lib/twilio-events";
import { recoverFailedComicTextFallbacks } from "@/lib/twilio-delivery";
import { db } from "@/lib/db";

const INBOUND_VISIBILITY_SECONDS = 45;
const INBOUND_RENEWAL_INTERVAL_MS = 15_000;
// Avoid continuous queue reads and active-rate CPU/network billing while idle.
const INBOUND_IDLE_POLL_MS = 5_000;
const DEFAULT_INBOUND_WORKER_CONCURRENCY = 4;
const REQUIRED_INBOUND_ENVIRONMENT = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
] as const;

function inboundWorkerConcurrency(): number {
  const configured = process.env.INBOUND_WORKER_CONCURRENCY?.trim();
  if (!configured) return DEFAULT_INBOUND_WORKER_CONCURRENCY;
  if (!/^[1-4]$/.test(configured)) {
    throw new Error("INBOUND_WORKER_CONCURRENCY must be an integer from 1 to 4");
  }
  return Number(configured);
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function processNextGenerationJob(): Promise<boolean> {
  const message = await receiveGenerationJob(20 * 60);
  if (!message) {
    return false;
  }

  if (message.version === 1) {
    const { processGenerationJob } = await import("@/lib/process-generation-job");
    await processGenerationJob(message.jobId);
  } else {
    try {
      await processInboundMessage(message.messageSid);
    } catch (error) {
      if (error instanceof EarlierInboundTurnsPendingError) {
        await renewGenerationJob(message, 1);
        return true;
      }
      if (error instanceof ConversationLeaseBusyError) {
        await renewGenerationJob(message, 15);
        return true;
      }
      await renewGenerationJob(message, 60);
      throw error;
    }
  }
  await deleteGenerationJob(message);
  return true;
}

/** Consume one conversational turn from the dedicated low-latency queue. */
export async function processNextInboundMessage(): Promise<boolean> {
  const message = await receiveInboundMessage(INBOUND_VISIBILITY_SECONDS);
  if (!message) return false;

  const insertedAt = message.insertedOn?.getTime();
  console.info(JSON.stringify({
    event: "inbound_worker_start",
    queueWaitMs: insertedAt !== undefined && Number.isFinite(insertedAt)
      ? Math.max(0, Date.now() - insertedAt)
      : null,
  }));

  let current = message;
  let stopped = false;
  let renewalFailed = false;
  let renewalFailure: unknown;
  let pendingRenewal = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || renewalFailed) return;
    pendingRenewal = pendingRenewal.then(async () => {
      if (!stopped) current = await renewInboundMessage(current, INBOUND_VISIBILITY_SECONDS);
    }).catch((error: unknown) => {
      renewalFailed = true;
      renewalFailure = error;
    });
  }, INBOUND_RENEWAL_INTERVAL_MS);

  const processingStartedAt = Date.now();
  let processingFailed = false;
  let processingFailure: unknown;
  try {
    await processInboundMessage(message.messageSid);
  } catch (error) {
    processingFailed = true;
    processingFailure = error;
  } finally {
    console.info(JSON.stringify({
      event: "inbound_worker_processed",
      processingMs: Math.max(0, Date.now() - processingStartedAt),
      outcome: processingFailed
        ? processingFailure instanceof ConversationLeaseBusyError ? "busy"
          : processingFailure instanceof EarlierInboundTurnsPendingError ? "backlog" : "failed"
        : "processed",
    }));
    stopped = true;
    clearInterval(timer);
    await pendingRenewal;
  }

  // A lost pop receipt must never be used to delete work that another replica may own.
  if (renewalFailed) throw renewalFailure;
  if (processingFailed) {
    if (processingFailure instanceof EarlierInboundTurnsPendingError) {
      await renewInboundMessage(current, 1);
      return true;
    }
    if (processingFailure instanceof ConversationLeaseBusyError) {
      await renewInboundMessage(current, 3);
      return true;
    }
    await renewInboundMessage(current, 60);
    throw processingFailure;
  }

  await deleteInboundMessage(current);
  return true;
}

async function pollInboundQueue(signal?: AbortSignal): Promise<void> {
  let failureCount = 0;
  while (!signal?.aborted) {
    try {
      const worked = await processNextInboundMessage();
      failureCount = 0;
      if (!worked) await waitForNextPoll(INBOUND_IDLE_POLL_MS, signal);
    } catch (error) {
      console.error("Inbound queue processing failed", error instanceof Error ? error.name : "unknown");
      failureCount += 1;
      await waitForNextPoll(Math.min(30_000, INBOUND_IDLE_POLL_MS * 2 ** (failureCount - 1)), signal);
    }
  }
}

async function runInboundWorker(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const concurrency = inboundWorkerConcurrency();
  for (const name of REQUIRED_INBOUND_ENVIRONMENT) {
    if (!process.env[name]?.trim()) {
      throw new Error(`Missing required inbound worker environment variable: ${name}`);
    }
  }
  await verifyInboundQueueAccess();
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    // PostgreSQL driver errors can include connection details. Keep the
    // startup failure visible without exposing credentials in worker logs.
    throw new Error("Inbound worker database preflight failed");
  }
  if (signal?.aborted) return;
  console.info(JSON.stringify({ event: "inbound_worker_ready" }));
  await Promise.all(Array.from({ length: concurrency }, () => pollInboundQueue(signal)));
}

export async function runWorker(signal?: AbortSignal): Promise<void> {
  if (process.env.RECOVERY_MODE === "1") {
    const sweeps = await Promise.allSettled([
      recoverPendingInboundMessages(),
      recoverUnpublishedGenerationJobs(),
      recoverFailedComicTextFallbacks(),
      recoverStalledAgentReplies(),
    ]);
    const failures = sweeps.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more recovery sweeps failed");
    }
    return;
  }
  if (process.env.WORKER_MODE === "inbound") {
    await runInboundWorker(signal);
    return;
  }
  await processNextGenerationJob();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  void runWorker(shutdown.signal).catch((error: unknown) => {
    console.error("Queue worker failed", error);
    process.exitCode = 1;
  });
}
