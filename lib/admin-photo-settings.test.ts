import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  saveStudio: vi.fn(),
  studioReady: vi.fn(),
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
vi.mock("@/lib/browser-studio-settings", () => ({
  getBrowserStudioEnabled: vi.fn().mockResolvedValue(false),
  setBrowserStudioEnabled: h.saveStudio,
}));
vi.mock("@/lib/studio-start-readiness", () => ({ isStudioStartReady: h.studioReady }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: h.redirect,
}));

import { updateBrowserStudioSetting, updateSmsVoiceSetting } from "@/app/admin/actions";
import AdminSettingsPage from "@/app/admin/(protected)/settings/page";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ user: { id: "", role: "admin", name: "operator" } });
  h.getSettings.mockResolvedValue({ voicePhotoMode: "sms", cameraEnabled: false });
  h.saveSettings.mockResolvedValue(undefined);
  h.saveStudio.mockResolvedValue(undefined);
  h.studioReady.mockReturnValue(true);
  vi.mocked(getBrowserStudioEnabled).mockResolvedValue(false);
  h.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("admin Voice photo configuration", () => {
  it("offers Browser Studio instead of the old phone-linked camera page", async () => {
    const html = renderToStaticMarkup(await AdminSettingsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(h.requireAdmin).toHaveBeenCalledOnce();
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="studioEnabled"/);
    expect(html).toContain("Browser Studio");
    expect(html).toContain("text their photos before calling");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="voiceEnabled"/);
    expect(html).not.toContain("Browser photo booth");
  });

  it("explains when the Studio switch is on but server setup is incomplete", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(true);
    h.studioReady.mockReturnValue(false);
    const html = renderToStaticMarkup(await AdminSettingsPage({
      searchParams: Promise.resolve({ saved: "studio" }),
    }));
    expect(html).toContain("unavailable until its runtime configuration is complete");
    expect(html).toContain("hidden from players");
    expect(html).not.toContain("available for players");
  });

});

describe("admin Browser Studio switch", () => {
  it("opens and closes the public browser route only for an admin", async () => {
    const enabled = new FormData();
    enabled.set("studioEnabled", "on");
    await expect(updateBrowserStudioSetting(enabled)).rejects.toThrow(
      "redirect:/admin/settings?saved=studio",
    );
    expect(h.saveStudio).toHaveBeenLastCalledWith(true);
    expect(h.revalidatePath).toHaveBeenCalledWith("/start");
    expect(h.revalidatePath).toHaveBeenCalledWith("/studio");

    await expect(updateBrowserStudioSetting(new FormData())).rejects.toThrow(
      "redirect:/admin/settings?saved=studio",
    );
    expect(h.saveStudio).toHaveBeenLastCalledWith(false);

    h.requireAdmin.mockRejectedValueOnce(new Error("redirect:/admin/login"));
    await expect(updateBrowserStudioSetting(enabled)).rejects.toThrow("redirect:/admin/login");
    expect(h.saveStudio).toHaveBeenCalledTimes(2);
  });

  it("rejects a tampered browser switch", async () => {
    const invalid = new FormData();
    invalid.set("studioEnabled", "anything");
    await expect(updateBrowserStudioSetting(invalid)).rejects.toThrow(
      "redirect:/admin/settings?error=invalid-studio",
    );
    expect(h.saveStudio).not.toHaveBeenCalled();
  });
});

describe("admin SMS + Voice switch", () => {
  it("enables text-first calls without discarding legacy staged photos", async () => {
    h.getSettings.mockResolvedValueOnce({ voicePhotoMode: "none", cameraEnabled: true });
    const form = new FormData();
    form.set("voiceEnabled", "on");
    await expect(updateSmsVoiceSetting(form)).rejects.toThrow(
      "redirect:/admin/settings?saved=voice",
    );
    expect(h.saveSettings).toHaveBeenCalledWith({ voicePhotoMode: "sms", cameraEnabled: false });
    expect(h.requireAdmin).toHaveBeenCalledOnce();
    expect(h.revalidatePath).toHaveBeenCalledWith("/start");
  });

  it("disables the call option but leaves SMS photo intake alone", async () => {
    await expect(updateSmsVoiceSetting(new FormData())).rejects.toThrow(
      "redirect:/admin/settings?saved=voice",
    );
    expect(h.saveSettings).toHaveBeenCalledWith({ voicePhotoMode: "none", cameraEnabled: false });
  });

  it("does not save when the administrator session is absent", async () => {
    h.requireAdmin.mockRejectedValueOnce(new Error("redirect:/admin/login"));
    const form = new FormData();
    form.set("voiceEnabled", "on");
    await expect(updateSmsVoiceSetting(form)).rejects.toThrow("redirect:/admin/login");
    expect(h.saveSettings).not.toHaveBeenCalled();
  });
});
