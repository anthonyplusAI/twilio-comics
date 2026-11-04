import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StudioPage from "@/app/studio/page";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";

vi.mock("@/lib/browser-studio-settings", () => ({
  getBrowserStudioEnabled: vi.fn(),
}));
vi.mock("@/lib/studio-start-readiness", () => ({
  isStudioStartReady: () => true,
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));
vi.mock("@/components/landing/comic-creation-form", () => ({
  ComicCreationForm: () => createElement("div", { "data-testid": "studio-form" }),
}));

beforeEach(() => {
  vi.mocked(getBrowserStudioEnabled).mockReset();
});

describe("public Browser Studio", () => {
  it("shows photo-first creation without a Google gate when enabled", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(true);
    const html = renderToStaticMarkup(await StudioPage());

    expect(html).toMatch(/Twilio Comics/);
    expect(html).toMatch(/one or two.*photos/i);
    expect(html).toContain('href="/start"');
    expect(html).toContain('data-testid="studio-form"');
    expect(html).toContain("Built by Twilio");
    expect(html).toContain("Make Comics");
    expect(html).toContain('href="https://x.com/anthonyplusAI"');
    expect(html).not.toMatch(/Google|approved testers/i);
  });

  it("closes direct Studio visits when the admin turns Browser mode off", async () => {
    vi.mocked(getBrowserStudioEnabled).mockResolvedValue(false);
    const html = renderToStaticMarkup(await StudioPage());

    expect(html).toMatch(/Browser Studio is closed/i);
    expect(html).toContain('href="/start"');
    expect(html).not.toContain('data-testid="studio-form"');
    expect(html).not.toMatch(/Sign in with Google/i);
  });
});
