export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "twilio-comics",
      release: process.env.RELEASE_SHA || "development",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
