export type HomeStartEntryMode = "qr" | "button" | "both";

/** The home page defaults to a single QR start control. */
export function getHomeStartEntryMode(raw = process.env.HOME_START_ENTRY_MODE): HomeStartEntryMode {
  const mode = raw?.trim().toLowerCase();
  return mode === "button" || mode === "both" ? mode : "qr";
}
