import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireAdmin: vi.fn(),
  getSettings: vi.fn(),
  rotate: vi.fn(),
  signOut: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth, signIn: vi.fn(), signOut: h.signOut }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/admin-access", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/admin-auth", () => ({
  rotateAdminCredentials: h.rotate,
  isAdminSession: (session: { user?: { role?: string } } | null) => session?.user?.role === "admin",
}));
vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: h.getSettings,
  setExperienceSettings: vi.fn(),
  isVoicePhotoMode: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import { updateAdminCredentials } from "@/app/admin/actions";
import AdminSettingsPage from "@/app/admin/(protected)/settings/page";
import AdminLoginPage from "@/app/admin/login/page";

function credentialForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  const values = {
    currentPassword: "current-private-password",
    newUsername: "new-operator",
    newPassword: "new-private-password-123",
    confirmNewPassword: "new-private-password-123",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(null);
  h.requireAdmin.mockResolvedValue({ user: { id: "admin:1", role: "admin", name: "current-operator" } });
  h.getSettings.mockResolvedValue({ voicePhotoMode: "sms", cameraEnabled: false });
  h.rotate.mockResolvedValue({ ok: true });
  h.signOut.mockResolvedValue(undefined);
  h.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("admin credential settings", () => {
  it("shows a short credential form alongside the existing photo settings", async () => {
    const html = renderToStaticMarkup(await AdminSettingsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Change admin login");
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('name="newUsername"');
    expect(html).toContain('value="current-operator"');
    expect(html).toContain('name="newPassword"');
    expect(html).toContain('name="confirmNewPassword"');
    expect(html).toContain("Offer camera and photo upload");
  });

  it("rejects mismatched passwords without attempting rotation", async () => {
    await expect(updateAdminCredentials(credentialForm({ confirmNewPassword: "another-password-123" })))
      .rejects.toThrow("redirect:/admin/settings?credentialError=mismatch#change-login");

    expect(h.requireAdmin).toHaveBeenCalledOnce();
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("rejects short passwords server-side", async () => {
    await expect(updateAdminCredentials(credentialForm({ newPassword: "short", confirmNewPassword: "short" })))
      .rejects.toThrow("redirect:/admin/settings?credentialError=invalid-input#change-login");
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("rejects unsupported usernames before attempting rotation", async () => {
    await expect(updateAdminCredentials(credentialForm({ newUsername: "bad username" })))
      .rejects.toThrow("redirect:/admin/settings?credentialError=invalid-input#change-login");
    await expect(updateAdminCredentials(credentialForm({ newUsername: "ab" })))
      .rejects.toThrow("redirect:/admin/settings?credentialError=invalid-input#change-login");
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("requires the current password and shows a safe failure code", async () => {
    h.rotate.mockResolvedValue({ ok: false, reason: "invalid-current" });

    await expect(updateAdminCredentials(credentialForm()))
      .rejects.toThrow("redirect:/admin/settings?credentialError=invalid-current#change-login");

    expect(h.rotate).toHaveBeenCalledWith({
      currentPassword: "current-private-password",
      newUsername: "new-operator",
      newPassword: "new-private-password-123",
    });
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.redirect.mock.calls.flat().join(" ")).not.toContain("private-password");
  });

  it("signs out to a success notice after rotating credentials", async () => {
    await updateAdminCredentials(credentialForm({ newUsername: "  new-operator  " }));

    expect(h.rotate).toHaveBeenCalledWith({
      currentPassword: "current-private-password",
      newUsername: "new-operator",
      newPassword: "new-private-password-123",
    });
    expect(h.signOut).toHaveBeenCalledWith({ redirectTo: "/admin/login?changed=1" });
  });

  it("does not rotate credentials without an admin session", async () => {
    h.requireAdmin.mockRejectedValueOnce(new Error("redirect:/admin/login"));

    await expect(updateAdminCredentials(credentialForm())).rejects.toThrow("redirect:/admin/login");
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("shows specific credential errors in settings and success on login", async () => {
    const settings = renderToStaticMarkup(await AdminSettingsPage({
      searchParams: Promise.resolve({ credentialError: "rate-limited" }),
    }));
    expect(settings).toContain("Too many attempts. Wait 15 minutes, then try again.");

    const reusedPassword = renderToStaticMarkup(await AdminSettingsPage({
      searchParams: Promise.resolve({ credentialError: "password-reused" }),
    }));
    expect(reusedPassword).toContain("Choose a new password that differs from your current password.");

    const login = renderToStaticMarkup(await AdminLoginPage({
      searchParams: Promise.resolve({ changed: "1" }),
    }));
    expect(login).toContain("Admin login updated. Sign in with your new username and password.");

    const invalidLogin = renderToStaticMarkup(await AdminLoginPage({
      searchParams: Promise.resolve({ error: "invalid" }),
    }));
    expect(invalidLogin).toContain("Sign in failed. Check your credentials or try again later.");
  });
});
