import { describe, expect, it } from "vitest";
import { linkedInShareIntent, resolveComicShareUrl, xShareIntent } from "./comic-share-links";

describe("comic share links", () => {
  const pageUrl = "https://comics.example/story/my-comic";

  it("uses a secure short link when one is available", () => {
    expect(resolveComicShareUrl("https://twil.io/comic-12", "https://comics.example", "/story/my-comic"))
      .toBe("https://twil.io/comic-12");
  });

  it("falls back to the canonical comic page for unsafe or missing links", () => {
    for (const preferred of [undefined, "javascript:alert(1)", "http://twil.io/comic-12", "https://x:y@twil.io/comic-12"] ) {
      expect(resolveComicShareUrl(preferred, "https://comics.example", "/story/my-comic"))
        .toBe(pageUrl);
    }
  });

  it("opens an X draft with the comic and Twilio credit", () => {
    const intent = new URL(xShareIntent(pageUrl));
    expect(intent.origin).toBe("https://x.com");
    expect(intent.searchParams.get("url")).toBe(pageUrl);
    expect(intent.searchParams.get("text")).toContain("@twilio #Twilio");
  });

  it("passes the complete comic URL to LinkedIn", () => {
    const intent = new URL(linkedInShareIntent("https://twil.io/comic-12?ref=share"));
    expect(intent.pathname).toBe("/sharing/share-offsite/");
    expect(intent.searchParams.get("url")).toBe("https://twil.io/comic-12?ref=share");
  });
});
