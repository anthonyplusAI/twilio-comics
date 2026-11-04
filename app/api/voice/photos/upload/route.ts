import { type NextRequest } from "next/server";
import { retiredCameraPhotoResponse } from "@/lib/browser-photo-access";

export const runtime = "nodejs";

/** Old verified cookies cannot add photos after this flow is retired. */
export function POST(_request: NextRequest): Response {
  void _request;
  return retiredCameraPhotoResponse();
}
