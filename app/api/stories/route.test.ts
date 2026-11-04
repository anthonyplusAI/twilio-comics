import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ actor: vi.fn(), readActor: vi.fn(), select: vi.fn(), from: vi.fn(), leftJoin: vi.fn(), where: vi.fn() }));
vi.mock("@/lib/studio-guest-session", () => ({ getStudioActor: h.actor, getStudioReadActor: h.readActor }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: h.select } }));

import { GET } from "@/app/api/stories/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: "693a8e78-5b98-49e6-9fc2-4b3352ac387a", kind: "guest" });
  h.readActor.mockResolvedValue({ userId: "693a8e78-5b98-49e6-9fc2-4b3352ac387a", kind: "guest" });
  h.select.mockReturnValue({ from: h.from });
  h.from.mockReturnValue({ leftJoin: h.leftJoin });
  h.leftJoin.mockReturnValue({ where: h.where });
  h.where.mockResolvedValue([{
    id: "a1111111-1111-4111-8111-111111111111",
    title: "A fox visits Mars",
    slug: "fox-visits-mars",
    style: "noir",
    createdAt: new Date("2026-11-03T12:00:00Z"),
    pageCount: 1,
    coverImage: "https://comics.example.com/api/media?key=page&token=test",
    pageCreatedAt: new Date("2026-11-03T12:01:00Z"),
    pageUpdatedAt: new Date("2026-11-03T12:01:00Z"),
  }]);
});

describe("GET /api/stories for Browser Studio", () => {
  it("lists comics under an invisible guest identity", async () => {
    const response = await GET(new Request("https://comics.example.com/api/stories"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stories).toMatchObject([{ slug: "fox-visits-mars", pageCount: 1 }]);
  });

  it("lists an existing guest's comics even when new Studio play is closed", async () => {
    h.actor.mockResolvedValue(null);

    const response = await GET(new Request("https://comics.example.com/api/stories"));

    expect(response.status).toBe(200);
    expect(h.readActor).toHaveBeenCalledOnce();
    expect(h.actor).not.toHaveBeenCalled();
  });

  it("also lists an authorized Google owner's comics after Studio closes", async () => {
    h.actor.mockResolvedValue(null);
    h.readActor.mockResolvedValue({ userId: "google-owner", kind: "google" });

    const response = await GET(new Request("https://comics.example.com/api/stories"));

    expect(response.status).toBe(200);
    expect(h.readActor).toHaveBeenCalledOnce();
    expect(h.actor).not.toHaveBeenCalled();
  });

  it("requires an existing guest or approved Google identity to list comics", async () => {
    h.readActor.mockResolvedValue(null);

    const response = await GET(new Request("https://comics.example.com/api/stories"));

    expect(response.status).toBe(401);
    expect(h.select).not.toHaveBeenCalled();
  });
});
