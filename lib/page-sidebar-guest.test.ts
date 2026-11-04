import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PageSidebar } from "@/components/editor/page-sidebar";

vi.mock("@/components/auth/account-menu", () => ({
  AccountMenu: () => createElement("span", null, "Google account menu"),
}));

const props = {
  pages: [{ id: 1, title: "My comic", image: "/noir.jpg", prompt: "", style: "noir" }],
  currentPage: 0,
  onPageSelect: () => {},
  onAddPage: () => {},
};

describe("comic page sidebar", () => {
  it("does not show the Google account menu to a guest comic owner", () => {
    const html = renderToStaticMarkup(createElement(PageSidebar, {
      ...props, isOwner: true, showAccountMenu: false,
    }));
    expect(html).not.toContain("Google account menu");
    expect(html).toContain("Page 1");
  });

  it("keeps the account menu for signed-in owners", () => {
    const html = renderToStaticMarkup(createElement(PageSidebar, {
      ...props, isOwner: true, showAccountMenu: true,
    }));
    expect(html).toContain("Google account menu");
  });
});
