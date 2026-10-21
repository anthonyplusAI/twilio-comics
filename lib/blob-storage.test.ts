import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const uploadData = vi.fn();
  const exists = vi.fn();
  const getBlockBlobClient = vi.fn((key: string) => ({
    url: `https://account.blob.core.windows.net/comics/${key}`,
    uploadData,
    exists,
  }));
  const getContainerClient = vi.fn(() => ({ getBlockBlobClient }));
  const serviceClient = { getContainerClient };
  return {
    credential: {},
    credentialConstructor: vi.fn(),
    serviceConstructor: vi.fn(),
    fromConnectionString: vi.fn(() => serviceClient),
    serviceClient,
    getContainerClient,
    getBlockBlobClient,
    uploadData,
    exists,
  };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function (options: unknown) {
    h.credentialConstructor(options);
    return h.credential;
  }),
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: Object.assign(
    vi.fn(function (endpoint: string, credential: unknown) {
      h.serviceConstructor(endpoint, credential);
      return h.serviceClient;
    }),
    { fromConnectionString: h.fromConnectionString },
  ),
}));

const environmentVariables = [
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_BLOB_ENDPOINT",
  "AZURE_STORAGE_CONTAINER_NAME",
  "AZURE_CLIENT_ID",
  "PUBLIC_BASE_URL",
  "MEDIA_SIGNING_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.uploadData.mockResolvedValue({});
  h.exists.mockResolvedValue(true);
  for (const name of environmentVariables) {
    delete process.env[name];
  }
  process.env.AZURE_STORAGE_CONTAINER_NAME = "comics";
  process.env.PUBLIC_BASE_URL = "https://comics.example.com";
  process.env.MEDIA_SIGNING_SECRET = "test-media-signing-secret";
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

describe("blob storage", () => {
  it("lazily uses a local connection string to upload and return the blob URL", async () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    const storage = await import("@/lib/blob-storage");

    expect(h.fromConnectionString).not.toHaveBeenCalled();
    const buffer = Buffer.from("png");
    const url = await storage.uploadBufferToBlob(
      buffer,
      "job/image.png",
      "image/png",
    );

    expect(h.fromConnectionString).toHaveBeenCalledWith(
      "UseDevelopmentStorage=true",
    );
    expect(h.credentialConstructor).not.toHaveBeenCalled();
    expect(h.uploadData).toHaveBeenCalledWith(buffer, {
      blobHTTPHeaders: { blobContentType: "image/png" },
    });
    const signedUrl = new URL(url);
    expect(`${signedUrl.origin}${signedUrl.pathname}`).toBe(
      "https://comics.example.com/api/media",
    );
    expect(signedUrl.searchParams.get("key")).toBe("job/image.png");
    expect(signedUrl.searchParams.get("token")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the endpoint and managed identity and reuses the lazy client", async () => {
    process.env.AZURE_STORAGE_BLOB_ENDPOINT =
      "https://account.blob.core.windows.net";
    process.env.AZURE_CLIENT_ID = "client-id";
    const storage = await import("@/lib/blob-storage");

    await expect(storage.blobExists("one.png")).resolves.toBe(true);
    const signedUrl = new URL(storage.getBlobPublicUrl("two.png"));
    expect(signedUrl.searchParams.get("key")).toBe("two.png");

    expect(h.credentialConstructor).toHaveBeenCalledOnce();
    expect(h.credentialConstructor).toHaveBeenCalledWith({
      managedIdentityClientId: "client-id",
    });
    expect(h.serviceConstructor).toHaveBeenCalledOnce();
    expect(h.serviceConstructor).toHaveBeenCalledWith(
      "https://account.blob.core.windows.net",
      h.credential,
    );
    expect(h.getContainerClient).toHaveBeenCalledOnce();
  });
});
