/** The former public app origin; only signed media links from this exact host need rewriting. */
const LEGACY_MEDIA_ORIGIN = "https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io";

/** Repoint an old signed media URL to the current app without following a cross-origin redirect. */
export function canonicalizeLegacyMediaUrl(url: URL, currentMediaUrl: URL): URL | null {
  if (
    url.origin !== LEGACY_MEDIA_ORIGIN ||
    url.pathname !== "/api/media" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return null;
  }

  const params = [...url.searchParams];
  if (
    params.length !== 2 ||
    params.filter(([name]) => name === "key").length !== 1 ||
    params.filter(([name]) => name === "token").length !== 1
  ) {
    return null;
  }
  const key = url.searchParams.get("key");
  const token = url.searchParams.get("token");
  if (!key || !token || !/^[a-f0-9]{64}$/i.test(token)) return null;

  const canonical = new URL(currentMediaUrl);
  canonical.search = "";
  canonical.hash = "";
  canonical.searchParams.set("key", key);
  canonical.searchParams.set("token", token);
  return canonical;
}
