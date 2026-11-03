import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/admin-auth", () => ({
  rotateAdminCredentials: vi.fn(),
  isAdminSession: (session: { user?: { role?: string } } | null) => session?.user?.role === "admin",
}));
vi.mock("@/lib/photo-experience-settings", () => ({
  isVoicePhotoMode: vi.fn(),
  setExperienceSettings: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { update: h.update } }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import { updateUserGenerationQuota } from "@/app/admin/actions";

const dialect = new PgDialect();

function quotaForm(mode: string, customLimit = "3", userId = "player-1"): FormData {
  const form = new FormData();
  form.set("userId", userId);
  form.set("quotaMode", mode);
  form.set("customLimit", customLimit);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { role: "admin" } });
  const query = { set: h.set, where: h.where, returning: h.returning };
  h.update.mockReturnValue(query);
  h.set.mockReturnValue(query);
  h.where.mockReturnValue(query);
  h.returning.mockResolvedValue([{ id: "player-1" }]);
  h.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("admin generation quota overrides", () => {
  it.each([
    ["default", "3", null],
    ["unlimited", "3", -1],
    ["custom", "0", 0],
    ["custom", "10", 10],
    ["custom", "10000", 10_000],
  ])("saves %s allowance %s for one player", async (mode, customLimit, expected) => {
    await expect(updateUserGenerationQuota(quotaForm(mode, customLimit))).rejects.toThrow(
      "redirect:/admin/users/player-1?quotaSaved=1#quota-settings",
    );

    expect(h.auth).toHaveBeenCalledOnce();
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({
      generationQuotaLimit: expected,
      updatedAt: expect.any(Date),
    }));
    const target = dialect.sqlToQuery(h.where.mock.calls[0][0]);
    expect(target.sql).toMatch(/"users"\."id" = \$\d+/);
    expect(target.params).toContain("player-1");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/users/player-1");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/users");
  });

  it.each(["", "-1", "1.5", "10001", " 5 ", "Infinity", "abc"])(
    "rejects invalid custom allowance %s without changing the player",
    async (customLimit) => {
      await expect(updateUserGenerationQuota(quotaForm("custom", customLimit))).rejects.toThrow(
        "redirect:/admin/users/player-1?quotaError=invalid#quota-settings",
      );

      expect(h.update).not.toHaveBeenCalled();
      expect(h.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate mode fields before updating the player", async () => {
    const form = quotaForm("custom", "10");
    form.append("quotaMode", "unlimited");

    await expect(updateUserGenerationQuota(form)).rejects.toThrow(
      "redirect:/admin/users/player-1?quotaError=invalid#quota-settings",
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("rejects duplicate player IDs before updating anyone", async () => {
    const form = quotaForm("unlimited");
    form.append("userId", "player-2");

    await expect(updateUserGenerationQuota(form)).rejects.toThrow("redirect:/admin/users");
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    ["a signed-out visitor", null],
    ["a signed-in non-admin", { user: { id: "ordinary-user", role: "user" } }],
  ])("does not save for %s", async (_description, session) => {
    h.auth.mockResolvedValueOnce(session);

    await expect(updateUserGenerationQuota(quotaForm("unlimited"))).rejects.toThrow(
      "redirect:/admin/login",
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("reports a missing player instead of claiming the change was saved", async () => {
    h.returning.mockResolvedValueOnce([]);

    await expect(updateUserGenerationQuota(quotaForm("custom", "10"))).rejects.toThrow(
      "redirect:/admin/users?quotaError=missing-user",
    );
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
