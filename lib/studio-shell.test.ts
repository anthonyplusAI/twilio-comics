import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StudioPage from "@/app/studio/page";

const authState = vi.hoisted(() => ({ status: "unauthenticated", role: "", id: "", studioAuthorized: false }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: authState.status,
    data: authState.status === "authenticated"
      ? { user: { role: authState.role, id: authState.id, studioAuthorized: authState.studioAuthorized } }
      : null,
  }),
}));

vi.mock("@/components/landing/comic-creation-form", () => ({
  ComicCreationForm: () => createElement("div", { "data-testid": "studio-form" }),
}));

describe("browser Studio", () => {
  it("explains photo-first creation and credits Twilio and Make Comics", () => {
    const html = renderToStaticMarkup(createElement(StudioPage));

    expect(html).toMatch(/Twilio Comics/);
    expect(html).toMatch(/one or two.*photos/i);
    expect(html).toContain('href="/start"');
    expect(html).toContain("Built by Twilio");
    expect(html).toContain("Make Comics");
    expect(html).toContain('href="https://x.com/anthonyplusAI"');
    expect(html).not.toContain("https://x.com/nutlope");
  });

  it("asks an admin session for Studio Google sign-in", () => {
    authState.status = "authenticated";
    authState.role = "admin";
    authState.id = "";
    authState.studioAuthorized = false;
    try {
      const html = renderToStaticMarkup(createElement(StudioPage));

      expect(html).toContain("Sign in with Google");
      expect(html).not.toContain('href="/stories"');
      expect(html).not.toContain("Sign out");
    } finally {
      authState.status = "unauthenticated";
      authState.role = "";
      authState.id = "";
      authState.studioAuthorized = false;
    }
  });

  it("shows an approved Google admin's Studio identity as signed in", () => {
    authState.status = "authenticated";
    authState.role = "admin";
    authState.id = "google-admin-user";
    authState.studioAuthorized = true;
    try {
      const html = renderToStaticMarkup(createElement(StudioPage));
      expect(html).toContain('href="/stories"');
      expect(html).toContain("Sign out");
      expect(html).not.toContain("Sign in with Google");
    } finally {
      authState.status = "unauthenticated";
      authState.role = "";
      authState.id = "";
      authState.studioAuthorized = false;
    }
  });
});
