import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/admin-access", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: h.getSettings,
  setExperienceSettings: h.saveSettings,
  isVoicePhotoMode: (value: unknown) => value === "sms" || value === "camera" || value === "none",
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: h.redirect,
}));

import { updatePhotoExperienceSettings } from "@/app/admin/actions";
import AdminSettingsPage from "@/app/admin/(protected)/settings/page";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ user: { id: "", role: "admin", name: "operator" } });
  h.getSettings.mockResolvedValue({ voicePhotoMode: "sms", cameraEnabled: false });
  h.saveSettings.mockResolvedValue(undefined);
  h.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

function settingsForm(mode: string, cameraEnabled = false): FormData {
  const form = new FormData();
  form.set("voicePhotoMode", mode);
  if (cameraEnabled) form.set("cameraEnabled", "on");
  return form;
}

describe("admin Voice photo configuration", () => {
  it("shows the saved Voice preference and separate browser camera switch", async () => {
    const html = renderToStaticMarkup(await AdminSettingsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(h.requireAdmin).toHaveBeenCalledOnce();
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="sms"/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="cameraEnabled"/);
    expect(html).toMatch(/<input[^>]*value="camera"/);
    expect(html).toContain("Offer camera and photo upload");
    expect(html).toContain("Use saved photos (text first)");
  });

  it("saves both choices only after checking the admin session", async () => {
    await expect(updatePhotoExperienceSettings(settingsForm("none", true))).rejects.toThrow(
      "redirect:/admin/settings?saved=1",
    );

    expect(h.requireAdmin).toHaveBeenCalledOnce();
    expect(h.saveSettings).toHaveBeenCalledWith({ voicePhotoMode: "none", cameraEnabled: true });
    expect(h.revalidatePath).toHaveBeenCalledWith("/start");
  });

  it("allows camera-first calls when the browser camera is enabled", async () => {
    await expect(updatePhotoExperienceSettings(settingsForm("camera", true))).rejects.toThrow(
      "redirect:/admin/settings?saved=1",
    );
    expect(h.saveSettings).toHaveBeenCalledWith({
      voicePhotoMode: "camera",
      cameraEnabled: true,
    });
  });

  it("requires camera to be enabled before choosing camera-first calls", async () => {
    await expect(updatePhotoExperienceSettings(settingsForm("camera"))).rejects.toThrow(
      "redirect:/admin/settings?error=camera-required",
    );
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it("rejects tampered form values", async () => {
    await expect(updatePhotoExperienceSettings(settingsForm("other"))).rejects.toThrow(
      "redirect:/admin/settings?error=invalid",
    );
    const form = settingsForm("sms");
    form.set("cameraEnabled", "maybe");
    await expect(updatePhotoExperienceSettings(form)).rejects.toThrow(
      "redirect:/admin/settings?error=invalid",
    );
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it("does not save when the administrator session is absent", async () => {
    h.requireAdmin.mockRejectedValueOnce(new Error("redirect:/admin/login"));

    await expect(updatePhotoExperienceSettings(settingsForm("sms"))).rejects.toThrow(
      "redirect:/admin/login",
    );
    expect(h.saveSettings).not.toHaveBeenCalled();
  });
});
