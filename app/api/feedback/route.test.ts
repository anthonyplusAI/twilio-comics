import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  submitTesterFeedback: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/feedback", () => ({ submitTesterFeedback: h.submitTesterFeedback }));

import { POST } from "@/app/api/feedback/route";

function request(body: string, contentType = "application/json"): NextRequest {
  return new NextRequest("https://comics.example.com/api/feedback", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "tester-1", role: "user" } });
  h.submitTesterFeedback.mockResolvedValue(true);
});

describe("POST /api/feedback", () => {
  it("rejects visitors and admin sessions before any database write", async () => {
    for (const session of [null, { user: { id: "", role: "admin" } }]) {
      h.auth.mockResolvedValueOnce(session);
      const response = await POST(request(JSON.stringify({ message: "An idea" })));
      expect(response.status).toBe(401);
    }
    expect(h.submitTesterFeedback).not.toHaveBeenCalled();
  });

  it("saves trimmed feedback for a signed-in tester", async () => {
    const response = await POST(request(JSON.stringify({ message: "  Better captions  " })));

    expect(response.status).toBe(200);
    expect(h.submitTesterFeedback).toHaveBeenCalledExactlyOnceWith("tester-1", "Better captions");
  });

  it("rejects malformed, oversize, and non-JSON requests without writing", async () => {
    const cases: Array<[NextRequest, number]> = [
      [request("{"), 400],
      [request(JSON.stringify({ message: "   " })), 400],
      [request(JSON.stringify({ message: "x".repeat(2_001) })), 400],
      [request(JSON.stringify({ message: "x".repeat(17_000) })), 413],
      [request("hello", "text/plain"), 415],
    ];
    for (const [input, status] of cases) {
      const response = await POST(input);
      expect(response.status).toBe(status);
    }
    expect(h.submitTesterFeedback).not.toHaveBeenCalled();
  });

  it("returns a rate-limit response after the tester's daily allowance", async () => {
    h.submitTesterFeedback.mockResolvedValue(false);

    const response = await POST(request(JSON.stringify({ message: "Another idea" })));

    expect(response.status).toBe(429);
    expect(h.submitTesterFeedback).toHaveBeenCalledOnce();
  });
});
