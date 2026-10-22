import { createHmac, timingSafeEqual } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
  getAzureCredential,
  requireAzureEnvironmentVariable,
} from "@/lib/azure-credential";

let containerClient: ContainerClient | undefined;

function getContainerClient(): ContainerClient {
  if (containerClient) {
    return containerClient;
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  const serviceClient = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(
        requireAzureEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT"),
        getAzureCredential(),
      );

  containerClient = serviceClient.getContainerClient(
    requireAzureEnvironmentVariable("AZURE_STORAGE_CONTAINER_NAME"),
  );
  return containerClient;
}

export function getBlobPublicUrl(key: string): string {
  const baseUrl = requireAzureEnvironmentVariable("PUBLIC_BASE_URL").replace(
    /\/$/,
    "",
  );
  const token = createHmac(
    "sha256",
    requireAzureEnvironmentVariable("MEDIA_SIGNING_SECRET"),
  )
    .update(key)
    .digest("hex");
  return `${baseUrl}/api/media?key=${encodeURIComponent(key)}&token=${token}`;
}

export function isValidMediaToken(key: string, token: string): boolean {
  const expected = createHmac(
    "sha256",
    requireAzureEnvironmentVariable("MEDIA_SIGNING_SECRET"),
  )
    .update(key)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function uploadBufferToBlob(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const blobClient = getContainerClient().getBlockBlobClient(key);
  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return getBlobPublicUrl(key);
}

export async function blobExists(key: string): Promise<boolean> {
  return getContainerClient().getBlockBlobClient(key).exists();
}

/** Read-only listing for a reviewed, per-owner deletion inventory. */
export async function listBlobKeysByPrefixes(prefixes: readonly string[]): Promise<string[]> {
  const keys = new Set<string>();
  for (const prefix of new Set(prefixes)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*\/$/.test(prefix)) {
      throw new Error("Invalid blob owner prefix");
    }
    for await (const blob of getContainerClient().listBlobsFlat({ prefix })) {
      if (!blob.name.startsWith(prefix)) {
        throw new Error("Blob listing returned a key outside the requested owner prefix");
      }
      keys.add(blob.name);
    }
  }
  return [...keys].sort();
}

export async function getBlobMetadata(key: string): Promise<{
  contentType: string;
  contentLength: number;
}> {
  const properties = await getContainerClient().getBlockBlobClient(key).getProperties();
  const contentLength = properties.contentLength;
  if (contentLength === undefined || !Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error("Blob is missing a valid content length");
  }
  return {
    contentType: properties.contentType || "application/octet-stream",
    contentLength,
  };
}

export async function downloadBlob(key: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const blobClient = getContainerClient().getBlockBlobClient(key);
  const [properties, buffer] = await Promise.all([
    blobClient.getProperties(),
    blobClient.downloadToBuffer(),
  ]);
  return {
    buffer,
    contentType: properties.contentType || "application/octet-stream",
  };
}
