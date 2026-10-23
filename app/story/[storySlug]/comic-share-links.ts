const X_SHARE_TEXT = "I made a comic with Twilio Comics! @twilio #Twilio";
const LINKEDIN_SHARE_TEXT = "I made a comic with Twilio Comics! #Twilio";

export function resolveComicShareUrl(
  preferredUrl: string | null | undefined,
  currentOrigin: string,
  currentPathname: string,
): string {
  const pageUrl = new URL(currentPathname, currentOrigin).toString();

  if (!preferredUrl) return pageUrl;

  try {
    const parsedUrl = new URL(preferredUrl);
    if (parsedUrl.protocol === "https:" && !parsedUrl.username && !parsedUrl.password) {
      return parsedUrl.toString();
    }
  } catch {
    // A missing or malformed short link should not prevent the comic from being shared.
  }

  return pageUrl;
}

export function xShareIntent(comicUrl: string): string {
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", X_SHARE_TEXT);
  intent.searchParams.set("url", comicUrl);
  return intent.toString();
}

export function linkedInShareIntent(comicUrl: string): string {
  const intent = new URL("https://www.linkedin.com/sharing/share-offsite/");
  intent.searchParams.set("url", comicUrl);
  return intent.toString();
}

export function linkedInShareCaption(comicUrl: string): string {
  return `${LINKEDIN_SHARE_TEXT}\n\n${comicUrl}`;
}
