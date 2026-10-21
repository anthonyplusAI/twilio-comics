import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteGenerationJob,
  receiveGenerationJob,
  renewGenerationJob,
} from "@/lib/generation-queue";
import {
  ConversationLeaseBusyError,
  processInboundMessage,
} from "@/lib/process-inbound-message";
import { recoverUnpublishedGenerationJobs } from "@/lib/generation-jobs";
import { processGenerationJob } from "@/lib/process-generation-job";
import { recoverPendingInboundMessages } from "@/lib/twilio-events";
import { recoverFailedMmsTextFallbacks } from "@/lib/twilio-delivery";

export async function processNextGenerationJob(): Promise<boolean> {
  const message = await receiveGenerationJob(20 * 60);
  if (!message) {
    return false;
  }

  if (message.version === 1) {
    await processGenerationJob(message.jobId);
  } else {
    try {
      await processInboundMessage(message.messageSid);
    } catch (error) {
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

export async function runWorker(): Promise<void> {
  if (process.env.RECOVERY_MODE === "1") {
    const sweeps = await Promise.allSettled([
      recoverPendingInboundMessages(),
      recoverUnpublishedGenerationJobs(),
      recoverFailedMmsTextFallbacks(),
    ]);
    const failures = sweeps.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more recovery sweeps failed");
    }
    return;
  }
  await processNextGenerationJob();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runWorker().catch((error: unknown) => {
    console.error("Queue worker failed", error);
    process.exitCode = 1;
  });
}
