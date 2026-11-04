import { type NextRequest } from "next/server";
import { retiredCameraPhotoResponse } from "@/lib/browser-photo-access";

export const runtime = "nodejs";

/** Retained for old browser tabs; this endpoint must never start new Verify sends. */
export function POST(_request: NextRequest): Response {
  void _request;
  return retiredCameraPhotoResponse();
}
