import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import StartPage from "@/app/start/page";

const PHONE = "+14155552671";
const WHATSAPP = "whatsapp:+447700900123";

afterEach(() => vi.unstubAllEnvs());

async function renderPage({
  channels,
  phone = PHONE,
  whatsapp = WHATSAPP,
  voiceReady = true,
}: {
  channels: string | undefined;
  phone?: string;
  whatsapp?: string;
  voiceReady?: boolean;
}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", phone);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", whatsapp);
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? `VA${"b".repeat(32)}` : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  return renderToStaticMarkup(await StartPage());
}

function directDestinations(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/href="((?:sms:|tel:|https:\/\/wa\.me\/)[^"]+)"/g)]
        .map((match) => match[1]),
    ),
  ];
}

function qrTitles(html: string): string[] {
  return [...html.matchAll(/<svg\b[^>]*\brole="img"[^>]*>\s*<title>([^<]+)<\/title>/g)]
    .map((match) => match[1]);
}

describe("channel chooser", () => {
  it("offers the first-launch SMS and Voice flows with nearby program disclosures", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      phone: "+18669012028",
      whatsapp: "",
    });

    expect(directDestinations(html)).toEqual([
      "sms:+18669012028",
      "tel:+18669012028",
    ]);
    expect(html).not.toContain("Twilio WhatsApp");
    expect(html).toMatch(/Message frequency varies/i);
    expect(html.match(/Message frequency varies/g)).toHaveLength(2);
    expect(html).toMatch(/Message and data rates may apply/i);
    expect(html).toMatch(/Reply HELP for help or STOP to opt out/i);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toMatch(/comic link[^<]*by SMS after the call/i);
    expect(html).toMatch(/code.+keypad/i);
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });

  it("opens SMS from the only enabled channel", async () => {
    const html = await renderPage({ channels: "sms" });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/text|sms/i)]);
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toContain(PHONE);
  });

  it("opens WhatsApp without a phone sender", async () => {
    const html = await renderPage({
      channels: "whatsapp",
      phone: "",
    });

    expect(directDestinations(html)).toEqual(["https://wa.me/447700900123"]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/whatsapp/i)]);
    expect(html).toMatch(/Twilio WhatsApp/);
  });

  it("opens a call without offering SMS as a separate channel", async () => {
    const html = await renderPage({ channels: "voice" });

    expect(directDestinations(html)).toEqual([`tel:${PHONE}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/call|voice/i)]);
    expect(html).toMatch(/Twilio Voice/);
    expect(html).toMatch(/comic link[^<]*by (?:SMS|text)/i);
  });

  it("keeps the call action unavailable until Voice verification is configured", async () => {
    const html = await renderPage({ channels: "sms,voice", voiceReady: false });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}`]);
    expect(html).not.toContain("Twilio Voice");
  });

  it("preserves the selected order for actions and gives each channel a QR", async () => {
    const html = await renderPage({ channels: "voice,whatsapp,sms" });

    expect(directDestinations(html)).toEqual([
      `tel:${PHONE}`,
      "https://wa.me/447700900123",
      `sms:${PHONE}`,
    ]);
    expect(qrTitles(html)).toEqual([
      expect.stringMatching(/call|voice/i),
      expect.stringMatching(/whatsapp/i),
      expect.stringMatching(/text|sms/i),
    ]);
  });

  it("keeps all start actions unavailable for an explicit empty selection", async () => {
    const html = await renderPage({ channels: "" });

    expect(directDestinations(html)).toEqual([]);
    expect(qrTitles(html)).toEqual([]);
    expect(html).toMatch(/opening soon|coming soon|not available|no channels/i);
  });

  it("keeps all start actions unavailable when channel selection is missing despite valid senders", async () => {
    const html = await renderPage({ channels: undefined });

    expect(directDestinations(html)).toEqual([]);
    expect(qrTitles(html)).toEqual([]);
    expect(html).toMatch(/opening soon|coming soon|not available|no channels/i);
  });

  it("does not expose actions or QR codes without real senders", async () => {
    const html = await renderPage({
      channels: "sms,whatsapp,voice",
      phone: "+15551234567",
      whatsapp: "whatsapp:+15551234567",
    });

    expect(directDestinations(html)).toEqual([]);
    expect(qrTitles(html)).toEqual([]);
  });
});
