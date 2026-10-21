import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const sendMessage = vi.fn();
  const receiveMessages = vi.fn();
  const updateMessage = vi.fn();
  const deleteMessage = vi.fn();
  const getQueueClient = vi.fn(() => ({
    sendMessage,
    receiveMessages,
    updateMessage,
    deleteMessage,
  }));
  const serviceClient = { getQueueClient };
  return {
    credential: {},
    credentialConstructor: vi.fn(),
    serviceConstructor: vi.fn(),
    fromConnectionString: vi.fn(() => serviceClient),
    getQueueClient,
    serviceClient,
    sendMessage,
    receiveMessages,
    updateMessage,
    deleteMessage,
  };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function (options: unknown) {
    h.credentialConstructor(options);
    return h.credential;
  }),
}));

vi.mock("@azure/storage-queue", () => ({
  QueueServiceClient: Object.assign(
    vi.fn(function (endpoint: string, credential: unknown) {
      h.serviceConstructor(endpoint, credential);
      return h.serviceClient;
    }),
    { fromConnectionString: h.fromConnectionString },
  ),
}));

const environmentVariables = [
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_QUEUE_ENDPOINT",
  "AZURE_STORAGE_QUEUE_NAME",
  "AZURE_CLIENT_ID",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.receiveMessages.mockReset();
  h.sendMessage.mockResolvedValue({ messageId: "sent" });
  h.receiveMessages.mockResolvedValue({ receivedMessageItems: [] });
  h.updateMessage.mockResolvedValue({ popReceipt: "receipt-2" });
  h.deleteMessage.mockResolvedValue({});
  for (const name of environmentVariables) {
    delete process.env[name];
  }
  process.env.AZURE_STORAGE_QUEUE_NAME = "generation";
});

afterEach(() => {
  for (const name of environmentVariables) {
    const value = originalEnvironment[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("generation queue", () => {
  it("lazily sends only the version and job ID through a connection string", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");

    expect(h.fromConnectionString).not.toHaveBeenCalled();
    await queue.sendGenerationJob("job-1");

    expect(h.fromConnectionString).toHaveBeenCalledWith(
      "UseDevelopmentStorage=true",
    );
    expect(h.credentialConstructor).not.toHaveBeenCalled();
    expect(JSON.parse(h.sendMessage.mock.calls[0][0])).toEqual({
      version: 1,
      jobId: "job-1",
    });
  });

  it("receives at most one valid message through managed identity", async () => {
    process.env.AZURE_STORAGE_QUEUE_ENDPOINT =
      "https://account.queue.core.windows.net";
    process.env.AZURE_CLIENT_ID = "client-id";
    h.receiveMessages.mockResolvedValue({
      receivedMessageItems: [
        {
          messageId: "message-1",
          popReceipt: "receipt-1",
          messageText: JSON.stringify({ version: 1, jobId: "job-1" }),
        },
      ],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveGenerationJob()).resolves.toEqual({
      version: 1,
      jobId: "job-1",
      messageId: "message-1",
      popReceipt: "receipt-1",
    });
    expect(h.receiveMessages).toHaveBeenCalledWith({
      numberOfMessages: 1,
      visibilityTimeout: 300,
    });
    expect(h.credentialConstructor).toHaveBeenCalledWith({
      managedIdentityClientId: "client-id",
    });
    expect(h.serviceConstructor).toHaveBeenCalledWith(
      "https://account.queue.core.windows.net",
      h.credential,
    );
  });

  it("renews with the exact payload and deletes with the latest receipt", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");
    const message = {
      version: 1 as const,
      jobId: "job-1",
      messageId: "message-1",
      popReceipt: "receipt-1",
    };

    const renewed = await queue.renewGenerationJob(message, 120);
    expect(h.updateMessage).toHaveBeenCalledWith(
      "message-1",
      "receipt-1",
      JSON.stringify({ version: 1, jobId: "job-1" }),
      120,
    );
    expect(renewed.popReceipt).toBe("receipt-2");

    await queue.deleteGenerationJob(renewed);
    expect(h.deleteMessage).toHaveBeenCalledWith("message-1", "receipt-2");
  });

  it("returns null for an empty queue and rejects extra payload fields", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveGenerationJob()).resolves.toBeNull();

    h.receiveMessages.mockResolvedValue({
      receivedMessageItems: [
        {
          messageId: "message-1",
          popReceipt: "receipt-1",
          messageText: JSON.stringify({
            version: 1,
            jobId: "job-1",
            prompt: "must not be queued",
          }),
        },
      ],
    });
    await expect(queue.receiveGenerationJob()).rejects.toThrow(
      "Invalid generation queue message",
    );
  });

  it("moves an invalid message to the poison queue after three receives", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.receiveMessages.mockResolvedValue({
      receivedMessageItems: [
        {
          messageId: "bad-message",
          popReceipt: "bad-receipt",
          messageText: "not-json",
          dequeueCount: 3,
        },
      ],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveGenerationJob()).resolves.toBeNull();
    expect(JSON.parse(h.sendMessage.mock.calls[0][0])).toEqual({
      version: 1,
      sourceMessageId: "bad-message",
      reason: "invalid_generation_message",
    });
    expect(h.deleteMessage).toHaveBeenCalledWith(
      "bad-message",
      "bad-receipt",
    );
  });

  it("sends an inbound wake-up with only a MessageSid", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");

    await queue.sendInboundMessage("SM123");

    expect(JSON.parse(h.sendMessage.mock.calls[0][0])).toEqual({
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
    });
  });

  it("receives inbound work while preserving legacy generation work", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [{
        messageId: "queue-inbound",
        popReceipt: "receipt-inbound",
        messageText: JSON.stringify({ version: 2, kind: "inbound", messageSid: "SM123" }),
      }],
    }).mockResolvedValueOnce({
      receivedMessageItems: [{
        messageId: "queue-generation",
        popReceipt: "receipt-generation",
        messageText: JSON.stringify({ version: 1, jobId: "job-1" }),
      }],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveGenerationJob()).resolves.toEqual({
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "queue-inbound",
      popReceipt: "receipt-inbound",
    });
    await expect(queue.receiveGenerationJob()).resolves.toEqual({
      version: 1,
      jobId: "job-1",
      messageId: "queue-generation",
      popReceipt: "receipt-generation",
    });
  });

  it("renews an inbound wake-up without adding private content", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");
    const message = {
      version: 2 as const,
      kind: "inbound" as const,
      messageSid: "SM123",
      messageId: "queue-inbound",
      popReceipt: "receipt-inbound",
    };

    const renewed = await queue.renewGenerationJob(message, 120);

    expect(h.updateMessage).toHaveBeenCalledWith(
      "queue-inbound",
      "receipt-inbound",
      JSON.stringify({ version: 2, kind: "inbound", messageSid: "SM123" }),
      120,
    );
    expect(renewed.popReceipt).toBe("receipt-2");
  });

  it("rejects inbound queue messages with user content", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.receiveMessages.mockResolvedValue({
      receivedMessageItems: [{
        messageId: "queue-inbound",
        popReceipt: "receipt-inbound",
        messageText: JSON.stringify({
          version: 2,
          kind: "inbound",
          messageSid: "SM123",
          body: "private comic idea",
        }),
      }],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveGenerationJob()).rejects.toThrow(
      "Invalid generation queue message",
    );
  });
});
