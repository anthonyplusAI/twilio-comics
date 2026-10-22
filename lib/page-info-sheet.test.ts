import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/sheet", () => {
  const slot = (tag: "div" | "h2") => {
    function MockSheetSlot({ children }: { children?: ReactNode }) {
      return createElement(tag, null, children);
    }
    return MockSheetSlot;
  };
  return {
    Sheet: slot("div"),
    SheetContent: slot("div"),
    SheetHeader: slot("div"),
    SheetTitle: slot("h2"),
  };
});

import { PageInfoSheet } from "@/components/editor/page-info-sheet";

const page = {
  id: 1,
  title: "Moon Comic",
  image: "https://example.com/page.jpg",
  prompt: "Private prompt about Casey",
  characterUploads: ["https://example.com/private-reference.jpg"],
  style: "classic",
};

describe("page information visibility", () => {
  it("does not render prompt or reference images for a non-owner", () => {
    const html = renderToStaticMarkup(createElement(PageInfoSheet, {
      isOpen: true,
      onClose: () => {},
      isOwner: false,
      page,
    }));

    expect(html).not.toContain("Private prompt about Casey");
    expect(html).not.toContain("private-reference.jpg");
    expect(html).not.toContain("Page 1 Details");
  });

  it("keeps editing details visible to the owner", () => {
    const html = renderToStaticMarkup(createElement(PageInfoSheet, {
      isOpen: true,
      onClose: () => {},
      isOwner: true,
      page,
    }));

    expect(html).toContain("Private prompt about Casey");
    expect(html).toContain("private-reference.jpg");
  });
});
