import { type NextRequest } from "next/server";
import { retiredCameraPhotoResponse } from "@/lib/browser-photo-access";

export const runtime = "nodejs";

/** Old challenges cannot open a new phone-linked photo session. */
export function POST(_request: NextRequest): Response {
  void _request;
  return retiredCameraPhotoResponse();
}
