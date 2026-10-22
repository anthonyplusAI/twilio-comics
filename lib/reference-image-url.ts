import { BlobServiceClient } from "@azure/storage-blob";
import { isValidMediaToken } from "@/lib/blob-storage";

/** Keep browser admission and image fetching on the same reference allowlist. */
export function isAllowedReferenceUrl(url: URL): boolean {
  if (url.username || url.password) return false;

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  const configuredEndpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT?.trim();
  const container = process.env.AZURE_STORAGE_CONTAINER_NAME?.trim();
  const blobEndpoint = connectionString
    ? new URL(BlobServiceClient.fromConnectionString(connectionString).url)
    : configuredEndpoint
      ? new URL(configuredEndpoint)
      : null;
  if (blobEndpoint && container) {
    const containerPath = `${blobEndpoint.pathname.replace(/\/+$/, "")}/${container}/`;
    if (url.origin === blobEndpoint.origin && url.pathname.startsWith(containerPath)) {
      return true;
    }
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) return false;
  const mediaUrl = new URL(`${publicBaseUrl.replace(/\/+$/, "")}/api/media`);
  if (url.origin !== mediaUrl.origin || url.pathname !== mediaUrl.pathname) return false;
  const key = url.searchParams.get("key");
  const token = url.searchParams.get("token");
  return Boolean(key && token && isValidMediaToken(key, token));
}

export function isAllowedReferenceImageUrl(value: string): boolean {
  if (!value || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return isAllowedReferenceUrl(url);
}
