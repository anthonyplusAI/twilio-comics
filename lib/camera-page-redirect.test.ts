import { describe, expect, it, vi } from "vitest";
import CameraPage from "@/app/start/camera/page";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { isStudioStartReady } from "@/lib/studio-start-readiness";

vi.mock("@/lib/browser-studio-settings", () => ({
  getBrowserStudioEnabled: vi.fn(),
}));
vi.mock("@/lib/studio-start-readiness", () => ({ isStudioStartReady: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error("redirect:" + path); },
}));

describe("old browser photo page link", () => {
  it("takes players to Studio when browser play is open", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(true);
    vi.mocked(isStudioStartReady).mockReturnValue(true);
    await expect(CameraPage()).rejects.toThrow("redirect:/studio");
  });

  it("takes players to the start page when browser play is closed", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(false);
    await expect(CameraPage()).rejects.toThrow("redirect:/start");
  });

  it("takes players to /start when Studio is enabled but runtime setup is incomplete", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(true);
    vi.mocked(isStudioStartReady).mockReturnValue(false);
    await expect(CameraPage()).rejects.toThrow("redirect:/start");
  });
});
