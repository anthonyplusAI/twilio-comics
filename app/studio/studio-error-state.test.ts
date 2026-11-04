import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => undefined }) }));

import { ComicCreationForm } from "@/components/landing/comic-creation-form";

it("shows a failed Studio session instead of a perpetual preparing message", () => {
  const props = {
    studioReady: false,
    sessionError: "Session request must be empty",
    prompt: "",
    setPrompt: () => undefined,
    style: "noir",
    setStyle: () => undefined,
    characterFiles: [],
    setCharacterFiles: () => undefined,
    isLoading: false,
    setIsLoading: () => undefined,
  };

  const html = renderToStaticMarkup(createElement(ComicCreationForm, props));

  expect(html).toContain("Browser Studio could not open");
  expect(html).not.toContain("Preparing Browser Studio");
});
