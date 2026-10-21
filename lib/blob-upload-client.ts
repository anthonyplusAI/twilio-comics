export interface BlobUploadResult {
  key: string;
  url: string;
}

export async function uploadFileToBlob(file: File): Promise<BlobUploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/blob-upload", {
    method: "POST",
    body: formData,
  });
  const result = (await response.json()) as Partial<BlobUploadResult> & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(result.error ?? "Failed to upload image");
  }
  if (typeof result.key !== "string" || typeof result.url !== "string") {
    throw new Error("Invalid blob upload response");
  }

  return { key: result.key, url: result.url };
}
