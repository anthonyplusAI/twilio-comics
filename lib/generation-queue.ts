import { QueueServiceClient, type QueueClient } from "@azure/storage-queue";
import {
  getAzureCredential,
  requireAzureEnvironmentVariable,
} from "@/lib/azure-credential";

const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 5 * 60;

export interface GenerationQueueMessage {
  version: 1;
  jobId: string;
}

export interface InboundQueueMessage {
  version: 2;
  kind: "inbound";
  messageSid: string;
}

export type QueueWorkMessage = GenerationQueueMessage | InboundQueueMessage;

export type ReceivedGenerationJob = QueueWorkMessage & {
  messageId: string;
  popReceipt: string;
};

let queueClient: QueueClient | undefined;
let poisonQueueClient: QueueClient | undefined;
let serviceClient: QueueServiceClient | undefined;

function getQueueServiceClient(): QueueServiceClient {
  if (serviceClient) return serviceClient;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  serviceClient = connectionString
    ? QueueServiceClient.fromConnectionString(connectionString)
    : new QueueServiceClient(
        requireAzureEnvironmentVariable("AZURE_STORAGE_QUEUE_ENDPOINT"),
        getAzureCredential(),
      );
  return serviceClient;
}

function getQueueClient(): QueueClient {
  if (queueClient) return queueClient;
  queueClient = getQueueServiceClient().getQueueClient(
    requireAzureEnvironmentVariable("AZURE_STORAGE_QUEUE_NAME"),
  );
  return queueClient;
}

function getPoisonQueueClient(): QueueClient {
  if (poisonQueueClient) return poisonQueueClient;
  poisonQueueClient = getQueueServiceClient().getQueueClient(
    process.env.AZURE_STORAGE_POISON_QUEUE_NAME || "comic-generation-poison",
  );
  return poisonQueueClient;
}

function serializeMessage(message: QueueWorkMessage): string {
  return JSON.stringify(message);
}

function parseMessage(messageText: string): QueueWorkMessage {
  let value: unknown;
  try {
    value = JSON.parse(messageText);
  } catch {
    throw new Error("Invalid generation queue message");
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    if (
      "version" in value && value.version === 1 &&
      keys.length === 2 &&
      "jobId" in value && typeof value.jobId === "string" && value.jobId.trim()
    ) {
      return { version: 1, jobId: value.jobId };
    }
    if (
      "version" in value && value.version === 2 &&
      keys.length === 3 &&
      "kind" in value && value.kind === "inbound" &&
      "messageSid" in value && typeof value.messageSid === "string" && value.messageSid.trim()
    ) {
      return { version: 2, kind: "inbound", messageSid: value.messageSid };
    }
  }
  throw new Error("Invalid generation queue message");
}

export async function sendGenerationJob(jobId: string): Promise<void> {
  if (!jobId.trim()) {
    throw new Error("jobId is required");
  }
  await getQueueClient().sendMessage(serializeMessage({ version: 1, jobId }));
}

export async function sendInboundMessage(messageSid: string): Promise<void> {
  if (!messageSid.trim()) {
    throw new Error("messageSid is required");
  }
  await getQueueClient().sendMessage(
    serializeMessage({ version: 2, kind: "inbound", messageSid }),
  );
}

export async function receiveGenerationJob(
  visibilityTimeout = DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
): Promise<ReceivedGenerationJob | null> {
  const response = await getQueueClient().receiveMessages({
    numberOfMessages: 1,
    visibilityTimeout,
  });
  const received = response.receivedMessageItems[0];
  if (!received) {
    return null;
  }

  let message: QueueWorkMessage;
  try {
    message = parseMessage(received.messageText);
  } catch (error) {
    if ((received.dequeueCount || 1) < 3) throw error;
    await getPoisonQueueClient().sendMessage(
      JSON.stringify({
        version: 1,
        sourceMessageId: received.messageId,
        reason: "invalid_generation_message",
      }),
    );
    await getQueueClient().deleteMessage(received.messageId, received.popReceipt);
    return null;
  }
  return {
    ...message,
    messageId: received.messageId,
    popReceipt: received.popReceipt,
  };
}

export async function renewGenerationJob(
  message: ReceivedGenerationJob,
  visibilityTimeout = DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
): Promise<ReceivedGenerationJob> {
  const receipt = await getQueueClient().updateMessage(
    message.messageId,
    message.popReceipt,
    serializeMessage(message.version === 1
      ? { version: 1, jobId: message.jobId }
      : { version: 2, kind: "inbound", messageSid: message.messageSid }),
    visibilityTimeout,
  );
  if (!receipt.popReceipt) {
    throw new Error("Azure Queue returned no pop receipt");
  }
  return { ...message, popReceipt: receipt.popReceipt };
}

export async function deleteGenerationJob(
  message: Pick<ReceivedGenerationJob, "messageId" | "popReceipt">,
): Promise<void> {
  await getQueueClient().deleteMessage(message.messageId, message.popReceipt);
}
