/** Return the public web origin needed by Twilio callbacks and QR links. */
export function getPublicOrigin(raw = process.env.PUBLIC_BASE_URL): string | null {
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    const localHttp = url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localHttp) ||
        url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
