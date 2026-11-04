import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const session = vi.hoisted(() => ({
  status: "authenticated",
  data: { user: { id: "google-user", role: "user", studioAuthorized: true } } as
    | { user: { id: string; role: "user" | "admin"; studioAuthorized: boolean } }
    | null,
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: session.status, data: session.data }),
  signIn: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-api-key", () => ({ useApiKey: () => ["", vi.fn()] }));
vi.mock("@/hooks/use-keyboard-shortcut", () => ({ useKeyboardShortcut: vi.fn() }));
const apiModal = vi.hoisted(() => ({ props: null as null | { theme?: string } }));
vi.mock("@/components/api-key-modal", () => ({
  ApiKeyModal: (props: { theme?: string }) => {
    apiModal.props = props;
    return null;
  },
}));
const camera = vi.hoisted(() => ({
  props: null as null | { onCapture: (file: File) => void; disabled?: boolean },
}));
vi.mock("@/components/camera/camera-capture", () => ({
  CameraCaptureButton: (props: { onCapture: (file: File) => void; disabled?: boolean; children?: ReactNode }) => {
    camera.props = props;
    return createElement("button", { type: "button", disabled: props.disabled }, props.children);
  },
}));

import { ComicCreationForm } from "@/components/landing/comic-creation-form";

function renderForm(
  photoCount: number,
  prompt = "A fox visits Mars",
  setCharacterFiles = vi.fn(),
  style = "noir",
): string {
  return renderToStaticMarkup(createElement(ComicCreationForm, {
    prompt,
    setPrompt: vi.fn(),
    style,
    setStyle: vi.fn(),
    characterFiles: Array.from({ length: photoCount }, (_, index) => ({
      name: `fox-${index}.png`,
      type: "image/png",
    } as File)),
    setCharacterFiles,
    isLoading: false,
    setIsLoading: vi.fn(),
  }));
}

function generateButton(html: string): string {
  return html.match(/<button[^>]*aria-label="Generate comic"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
}

describe("Studio reference photo requirement", () => {
  it("puts required photos first and disables Generate until a photo and idea are present", () => {
    const withoutPhoto = renderForm(0);
    const withPhoto = renderForm(1);
    const withoutIdea = renderForm(1, "  ");

    expect(withoutPhoto).toMatch(/Add 1 or 2 reference photos/i);
    expect(withoutPhoto.indexOf("Add 1 or 2 reference photos")).toBeLessThan(withoutPhoto.indexOf("Your comic idea"));
    expect(withoutPhoto).toMatch(/First photo required/i);
    expect(generateButton(withoutPhoto)).toMatch(/\sdisabled=""/);
    expect(generateButton(withPhoto)).not.toMatch(/\sdisabled=""/);
    expect(generateButton(withoutIdea)).toMatch(/\sdisabled=""/);
  });

  it("offers separate photo picker and camera controls for up to two references", () => {
    const empty = renderForm(0);
    const full = renderForm(2);

    expect(empty).toMatch(/Choose photo/i);
    expect(empty).toMatch(/Take photo/i);
    expect(empty).toMatch(/0 of 2 photos added/i);
    expect(full).toMatch(/2 of 2 photos added/i);
    expect(full).toMatch(/Remove reference photo 1/i);
    expect(full).toMatch(/Remove reference photo 2/i);
    expect(camera.props?.disabled).toBe(true);
  });

  it("adds a camera capture as the second reference photo", () => {
    const setCharacterFiles = vi.fn();
    renderForm(1, "A fox visits Mars", setCharacterFiles);
    expect(camera.props?.disabled).toBe(false);

    const capturedPhoto = { name: "portrait.jpg", type: "image/jpeg", size: 1024 } as File;
    camera.props?.onCapture(capturedPhoto);

    expect(setCharacterFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: "fox-0.png" }),
      capturedPhoto,
    ]);
  });

  it("reflects the style controlled by the Studio preview", () => {
    const manga = renderForm(1, "A fox visits Mars", vi.fn(), "manga");
    expect(manga).toMatch(/aria-pressed="true">Manga<\/button>/);
    expect(manga).toMatch(/aria-pressed="false">Noir<\/button>/);
  });

  it("keeps a visible API key path with the Studio dialog theme", () => {
    const html = renderForm(1);
    expect(html).toMatch(/Use my OpenAI key/);
    expect(apiModal.props?.theme).toBe("studio");
  });

  it("requires sign-in before choosing or taking photos so the selection survives auth", () => {
    session.status = "unauthenticated";
    session.data = null;
    try {
      const html = renderForm(0);
      expect(html).toMatch(/Sign in with Google to add photos/);
      expect(html.indexOf("Sign in with Google to add photos")).toBeLessThan(html.indexOf("Add 1 or 2 reference photos"));
      expect(camera.props?.disabled).toBe(true);
      expect(generateButton(html)).toMatch(/\sdisabled=""/);
    } finally {
      session.status = "authenticated";
      session.data = { user: { id: "google-user", role: "user", studioAuthorized: true } };
    }
  });

  it("lets an approved Google admin with a Studio identity create a comic", () => {
    session.data = { user: { id: "google-admin-user", role: "admin", studioAuthorized: true } };
    try {
      const html = renderForm(1);
      expect(camera.props?.disabled).toBe(false);
      expect(generateButton(html)).not.toMatch(/\sdisabled=""/);
      expect(html).toMatch(/Use my OpenAI key/);
    } finally {
      session.data = { user: { id: "google-user", role: "user", studioAuthorized: true } };
    }
  });

  it("blocks password admin and invalid browser sessions from photo upload, generation, and key management", () => {
    for (const user of [
      { id: "", role: "admin" as const, studioAuthorized: false },
      { id: "   ", role: "user" as const, studioAuthorized: true },
    ]) {
      session.data = { user };
      const html = renderForm(1);
      expect(html).toMatch(/Sign in with Google to add photos/);
      expect(camera.props?.disabled).toBe(true);
      expect(html).toMatch(/<input[^>]*aria-label="Choose reference photos"[^>]*disabled=""/);
      expect(generateButton(html)).toMatch(/\sdisabled=""/);
      expect(html).not.toMatch(/Use my OpenAI key|Manage OpenAI key/);
    }
    session.data = { user: { id: "google-user", role: "user", studioAuthorized: true } };
  });

  it.each([
    ["WebP", "image/webp", "portrait.webp"],
    ["HEIC", "image/heic", "portrait.heic"],
    ["HEIF", "image/heif", "portrait.heif"],
    ["HEIC with a generic MIME type", "", "portrait.heic"],
  ])("accepts a %s reference photo", (_label, type, name) => {
    const setCharacterFiles = vi.fn();
    const html = renderForm(0, "A fox visits Mars", setCharacterFiles);
    expect(html).toMatch(/accept="[^"]*image\/webp[^"]*image\/heic[^"]*image\/heif/);

    const photo = { name, type, size: 1024 } as File;
    camera.props?.onCapture(photo);
    expect(setCharacterFiles).toHaveBeenCalledWith([photo]);
  });

  it("rejects a reference photo over 5 MiB before upload", () => {
    const setCharacterFiles = vi.fn();
    toast.mockClear();
    renderForm(0, "A fox visits Mars", setCharacterFiles);

    camera.props?.onCapture({
      name: "large.heic",
      type: "image/heic",
      size: 5 * 1024 * 1024 + 1,
    } as File);

    expect(setCharacterFiles).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Choose a supported photo",
    }));
  });
});
