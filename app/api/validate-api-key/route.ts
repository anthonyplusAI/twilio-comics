import { type NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { valid: false, error: "Authentication required" },
        { status: 401 },
      );
    }
    const { apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { valid: false, error: "API key is required" },
        { status: 400 },
      );
    }

    // Cheap validating call: list models. Succeeds only for a valid key.
    const client = new OpenAI({ apiKey });
    await client.models.list();

    return NextResponse.json({ valid: true });
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status: number }).status
        : undefined;

    if (status === 401 || status === 403) {
      return NextResponse.json({ valid: false, error: "Invalid API key" });
    }

    return NextResponse.json(
      { valid: false, error: "Validation failed" },
      { status: 500 },
    );
  }
}
