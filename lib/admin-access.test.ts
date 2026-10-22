import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), redirect: vi.fn() }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("next/navigation", () => ({
  redirect: h.redirect,
}));

import { requireAdmin } from "@/lib/admin-access";

beforeEach(() => {
  vi.clearAllMocks();
  h.redirect.mockImplementation(() => {
    throw new Error("redirected");
  });
});

describe("admin page guard", () => {
  it("rejects an ordinary signed-in Google user", async () => {
    h.auth.mockResolvedValue({ user: { id: "google-user", role: "user" } });
    await expect(requireAdmin()).rejects.toThrow("redirected");
    expect(h.redirect).toHaveBeenCalledWith("/admin/login");
  });

  it("allows a signed admin role even though it has no browser user ID", async () => {
    const session = { user: { id: "", role: "admin", name: "operator" } };
    h.auth.mockResolvedValue(session);
    await expect(requireAdmin()).resolves.toEqual(session);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
