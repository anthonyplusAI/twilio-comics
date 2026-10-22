import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { submitTesterFeedback } from "@/lib/feedback";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const feedbackSchema = z.object({ message: z.string().trim().min(1).max(2_000) });

async function readBoundedJson(request: NextRequest): Promise<unknown | "too_large"> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return "too_large";

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.role === "user" ? session.user.id : null;
  if (!userId) {
    return NextResponse.json({ error: "Sign in to the testing studio to send feedback" }, { status: 401 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "JSON required" }, { status: 415 });
  }

  const body = await readBoundedJson(request);
  if (body === "too_large") {
    return NextResponse.json({ error: "Feedback is too long" }, { status: 413 });
  }
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Message must be 1 to 2,000 characters" }, { status: 400 });
  }

  try {
    const saved = await submitTesterFeedback(userId, parsed.data.message);
    return saved
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: "Feedback limit reached; try again tomorrow" }, { status: 429 });
  } catch (error) {
    console.error("Feedback could not be saved", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Feedback unavailable" }, { status: 503 });
  }
}
