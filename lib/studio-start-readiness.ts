import { getPublicOrigin } from "@/lib/public-origin";

/** A Studio link should appear only when anonymous creation can run. */
export function isStudioStartReady(): boolean {
  return Boolean(
    getPublicOrigin() &&
    process.env.AUTH_SECRET?.trim() &&
    process.env.OPENAI_API_KEY?.trim() &&
    process.env.MEDIA_SIGNING_SECRET?.trim() &&
    process.env.AZURE_STORAGE_CONTAINER_NAME?.trim() &&
    (process.env.AZURE_STORAGE_BLOB_ENDPOINT?.trim() ||
      process.env.AZURE_STORAGE_CONNECTION_STRING?.trim()),
  );
}
