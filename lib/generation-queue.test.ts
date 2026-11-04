import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const sendMessage = vi.fn();
  const receiveMessages = vi.fn();
  const updateMessage = vi.fn();
  const deleteMessage = vi.fn();
  const generationGetProperties = vi.fn();
  const generationClient = {
    sendMessage,
    receiveMessages,
    updateMessage,
    deleteMessage,
    getProperties: generationGetProperties,
  };
  const inboundSendMessage = vi.fn();
  const inboundReceiveMessages = vi.fn();
  const inboundUpdateMessage = vi.fn();
  const inboundDeleteMessage = vi.fn();
  const inboundGetProperties = vi.fn();
  const inboundClient = {
    sendMessage: inboundSendMessage,
    receiveMessages: inboundReceiveMessages,
    updateMessage: inboundUpdateMessage,
    deleteMessage: inboundDeleteMessage,
    getProperties: inboundGetProperties,
  };
  const generationPoisonSendMessage = vi.fn();
  const inboundPoisonSendMessage = vi.fn();
  const generationPoisonClient = { sendMessage: generationPoisonSendMessage };
  const inboundPoisonClient = { sendMessage: inboundPoisonSendMessage };
  const getQueueClient = vi.fn((name: string) =>
    name === "inbound" ? inboundClient
      : name === "comic-inbound-poison" || name === "inbound-poison" ? inboundPoisonClient
        : name === "comic-generation-poison" ? generationPoisonClient : generationClient);
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
    generationGetProperties,
    inboundSendMessage,
    inboundReceiveMessages,
    inboundUpdateMessage,
    inboundDeleteMessage,
    inboundGetProperties,
    generationPoisonSendMessage,
    inboundPoisonSendMessage,
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
  "AZURE_STORAGE_INBOUND_QUEUE_NAME",
  "AZURE_STORAGE_POISON_QUEUE_NAME",
  "AZURE_STORAGE_INBOUND_POISON_QUEUE_NAME",
  "AZURE_CLIENT_ID",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.receiveMessages.mockReset();
  h.inboundReceiveMessages.mockReset();
  h.sendMessage.mockResolvedValue({ messageId: "sent" });
  h.inboundSendMessage.mockResolvedValue({ messageId: "sent-inbound" });
  h.receiveMessages.mockResolvedValue({ receivedMessageItems: [] });
  h.inboundReceiveMessages.mockResolvedValue({ receivedMessageItems: [] });
  h.updateMessage.mockResolvedValue({ popReceipt: "receipt-2" });
  h.inboundUpdateMessage.mockResolvedValue({ popReceipt: "inbound-receipt-2" });
  h.deleteMessage.mockResolvedValue({});
  h.inboundDeleteMessage.mockResolvedValue({});
  h.inboundGetProperties.mockResolvedValue({});
  h.generationGetProperties.mockResolvedValue({});
  h.generationPoisonSendMessage.mockResolvedValue({ messageId: "sent-generation-poison" });
  h.inboundPoisonSendMessage.mockResolvedValue({ messageId: "sent-inbound-poison" });
  for (const name of environmentVariables) {
    delete process.env[name];
  }
  process.env.AZURE_STORAGE_QUEUE_NAME = "generation";
  process.env.AZURE_STORAGE_INBOUND_QUEUE_NAME = "inbound";
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
    expect(JSON.parse(h.generationPoisonSendMessage.mock.calls[0][0])).toEqual({
      version: 1,
      sourceMessageId: "bad-message",
      reason: "invalid_generation_message",
    });
    expect(h.inboundPoisonSendMessage).not.toHaveBeenCalled();
    expect(h.deleteMessage).toHaveBeenCalledWith(
      "bad-message",
      "bad-receipt",
    );
  });

  it("sends an inbound wake-up with only a MessageSid", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");

    await queue.sendInboundMessage("SM123");

    expect(JSON.parse(h.inboundSendMessage.mock.calls[0][0])).toEqual({
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps publishing to the legacy queue until the inbound queue is configured", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    delete process.env.AZURE_STORAGE_INBOUND_QUEUE_NAME;
    const queue = await import("@/lib/generation-queue");

    await queue.sendInboundMessage("SM123");

    expect(JSON.parse(h.sendMessage.mock.calls[0][0])).toEqual({
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
    });
    expect(h.inboundSendMessage).not.toHaveBeenCalled();
  });

  it("rejects an inbound queue configured with the generation queue name", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    process.env.AZURE_STORAGE_INBOUND_QUEUE_NAME = " generation ";
    const queue = await import("@/lib/generation-queue");

    await expect(queue.sendInboundMessage("SM123")).rejects.toThrow(
      "AZURE_STORAGE_INBOUND_QUEUE_NAME must differ from AZURE_STORAGE_QUEUE_NAME",
    );
    await expect(queue.verifyInboundQueueAccess()).rejects.toThrow(
      "AZURE_STORAGE_INBOUND_QUEUE_NAME must differ from AZURE_STORAGE_QUEUE_NAME",
    );
    await expect(queue.receiveInboundMessage()).rejects.toThrow(
      "AZURE_STORAGE_INBOUND_QUEUE_NAME must differ from AZURE_STORAGE_QUEUE_NAME",
    );
    expect(h.getQueueClient).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.generationGetProperties).not.toHaveBeenCalled();
  });

  it("quarantines malformed inbound work in the dedicated default poison queue", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.inboundReceiveMessages.mockResolvedValue({
      receivedMessageItems: [{
        messageId: "bad-inbound",
        popReceipt: "bad-receipt",
        messageText: JSON.stringify({ version: 1, jobId: "job-must-stay-in-generation" }),
        dequeueCount: 3,
      }],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveInboundMessage()).resolves.toBeNull();

    expect(h.getQueueClient).toHaveBeenCalledWith("comic-inbound-poison");
    expect(JSON.parse(h.inboundPoisonSendMessage.mock.calls[0][0])).toEqual({
      version: 1,
      sourceMessageId: "bad-inbound",
      reason: "invalid_inbound_message",
    });
    expect(h.generationPoisonSendMessage).not.toHaveBeenCalled();
    expect(h.inboundDeleteMessage).toHaveBeenCalledWith("bad-inbound", "bad-receipt");
  });

  it("honors the configured inbound poison queue", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    process.env.AZURE_STORAGE_INBOUND_POISON_QUEUE_NAME = "inbound-poison";
    h.inboundReceiveMessages.mockResolvedValue({
      receivedMessageItems: [{
        messageId: "bad-inbound",
        popReceipt: "bad-receipt",
        messageText: "not-json",
        dequeueCount: 3,
      }],
    });
    const queue = await import("@/lib/generation-queue");

    await expect(queue.receiveInboundMessage()).resolves.toBeNull();
    expect(h.getQueueClient).toHaveBeenCalledWith("inbound-poison");
    expect(h.inboundPoisonSendMessage).toHaveBeenCalledOnce();
    expect(h.generationPoisonSendMessage).not.toHaveBeenCalled();
  });

  it("receives, renews, and deletes inbound work only through its dedicated queue", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.inboundReceiveMessages.mockResolvedValue({
      receivedMessageItems: [{
        messageId: "inbound-1",
        popReceipt: "receipt-1",
        insertedOn: new Date("2026-11-04T07:59:57.500Z"),
        messageText: JSON.stringify({ version: 2, kind: "inbound", messageSid: "SM123" }),
      }],
    });
    const queue = await import("@/lib/generation-queue");

    const message = await queue.receiveInboundMessage(60);
    expect(message).toEqual({
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
      insertedOn: new Date("2026-11-04T07:59:57.500Z"),
    });
    expect(h.inboundReceiveMessages).toHaveBeenCalledWith({
      numberOfMessages: 1,
      visibilityTimeout: 60,
    });
    expect(h.receiveMessages).not.toHaveBeenCalled();

    const renewed = await queue.renewInboundMessage(message!, 60);
    expect(h.inboundUpdateMessage).toHaveBeenCalledWith(
      "inbound-1",
      "receipt-1",
      JSON.stringify({ version: 2, kind: "inbound", messageSid: "SM123" }),
      60,
    );
    expect(renewed.popReceipt).toBe("inbound-receipt-2");
    await queue.deleteInboundMessage(renewed);
    expect(h.inboundDeleteMessage).toHaveBeenCalledWith("inbound-1", "inbound-receipt-2");
    expect(h.deleteMessage).not.toHaveBeenCalled();
  });

  it("checks the inbound queue exists and is readable before starting a worker", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const queue = await import("@/lib/generation-queue");

    await queue.verifyInboundQueueAccess();

    expect(h.inboundGetProperties).toHaveBeenCalledOnce();
    expect(h.getQueueClient).toHaveBeenCalledWith("inbound");
  });

  it("fails the inbound preflight when Azure denies queue access", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    h.inboundGetProperties.mockRejectedValue(new Error("Queue access denied"));
    const queue = await import("@/lib/generation-queue");

    await expect(queue.verifyInboundQueueAccess()).rejects.toThrow("Queue access denied");
  });

  it("does not let the warm worker preflight silently use the legacy queue", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    delete process.env.AZURE_STORAGE_INBOUND_QUEUE_NAME;
    const queue = await import("@/lib/generation-queue");

    await expect(queue.verifyInboundQueueAccess()).rejects.toThrow("AZURE_STORAGE_INBOUND_QUEUE_NAME");
    expect(h.inboundGetProperties).not.toHaveBeenCalled();
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
