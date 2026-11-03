import { BlobServiceClient } from "@azure/storage-blob";
import { isValidMediaToken } from "@/lib/blob-storage";
import { canonicalizeLegacyMediaUrl } from "@/lib/legacy-media-url";

/** Keep browser admission and image fetching on the same reference allowlist. */
export function allowedReferenceFetchUrl(url: URL): URL | null {
  if (url.username || url.password) return null;

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
      return url;
    }
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) return null;
  const mediaUrl = new URL(`${publicBaseUrl.replace(/\/+$/, "")}/api/media`);
  const currentMediaUrl = url.origin === mediaUrl.origin && url.pathname === mediaUrl.pathname;
  const legacyMediaUrl = canonicalizeLegacyMediaUrl(url, mediaUrl);
  if (!currentMediaUrl && !legacyMediaUrl) return null;
  const key = url.searchParams.get("key");
  const token = url.searchParams.get("token");
  return key && token && isValidMediaToken(key, token) ? legacyMediaUrl ?? url : null;
}

export function isAllowedReferenceUrl(url: URL): boolean {
  return allowedReferenceFetchUrl(url) !== null;
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
