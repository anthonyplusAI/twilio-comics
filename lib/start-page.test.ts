import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import StartPage from "@/app/start/page";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import type { VoicePhotoMode } from "@/lib/schema";

vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: vi.fn(),
}));

const PHONE = "+14155552671";
const WHATSAPP = "whatsapp:+447700900123";
const START_BODY = "Turn%20me%20into%20a%20comic!";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getExperienceSettings).mockReset();
});

async function renderPage({
  channels,
  phone = PHONE,
  whatsapp = WHATSAPP,
  voiceReady = true,
  voicePhotoMode = "sms",
  cameraEnabled = false,
}: {
  channels: string | undefined;
  phone?: string;
  whatsapp?: string;
  voiceReady?: boolean;
  voicePhotoMode?: VoicePhotoMode;
  cameraEnabled?: boolean;
}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", phone);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", whatsapp);
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? `VA${"b".repeat(32)}` : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  vi.mocked(getExperienceSettings).mockResolvedValue({ voicePhotoMode, cameraEnabled });
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

function cardMarkup(html: string): string[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0]);
}

describe("channel chooser", () => {
  it("shows short SMS and Voice choices with one nearby disclosure", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      phone: "+18669012028",
      whatsapp: "",
    });

    expect(directDestinations(html)).toEqual([
      `sms:+18669012028?body=${START_BODY}`,
      "tel:+18669012028",
    ]);
    expect(html).not.toMatch(/\bNEW\b/);
    expect(html).not.toContain("Twilio WhatsApp");
    expect(html.match(/Message frequency varies/g)).toHaveLength(1);
    expect(html).toMatch(/Automated replies and comic links by text/i);
    expect(html).toMatch(/Message and data rates may apply/i);
    expect(html).toMatch(/Reply HELP for help or STOP to opt out/i);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html.indexOf("Message frequency varies")).toBeLessThan(html.indexOf("<article"));

    const cards = cardMarkup(html);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatch(/Twilio SMS/);
    expect(cards[1]).toMatch(/Twilio Voice/);
    for (const card of cards) {
      expect(card).not.toMatch(/Message frequency|HELP|STOP|photo|comic link|code/i);
    }
    expect(html).toMatch(/Text up to two photos, then keep texting or call from the same number/i);
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });

  it("keeps instructions outside the cards in a collapsed guide", async () => {
    const html = await renderPage({ channels: "sms,voice" });

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("Choose how to start.");
    expect(html).toMatch(/<details\b[\s\S]*?<summary>How it works<\/summary>/);
    expect(html).toMatch(/Confirm the SMS code, then tell the agent your idea/i);
    expect(cardMarkup(html).join(" ")).not.toMatch(/How it works|SMS code|your idea/i);
    expect(html).toMatch(/Forked from[^<]*<a[^>]*>Make Comics<\/a>/);
  });

  it("opens SMS from the only enabled channel", async () => {
    const html = await renderPage({ channels: "sms" });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}?body=${START_BODY}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/text|sms/i)]);
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toContain(PHONE);
    expect(html).toMatch(/Text up to two photos, then share your idea/i);
    expect(getExperienceSettings).toHaveBeenCalledOnce();
  });

  it("opens WhatsApp without a phone sender", async () => {
    const html = await renderPage({
      channels: "whatsapp",
      phone: "",
    });

    expect(directDestinations(html)).toEqual([`https://wa.me/447700900123?text=${START_BODY}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/whatsapp/i)]);
    expect(html).toMatch(/Twilio WhatsApp/);
    expect(html).toMatch(/automated replies and comic links in WhatsApp/i);
    expect(html).not.toMatch(/Reply HELP for help or STOP to opt out/i);
    expect(getExperienceSettings).not.toHaveBeenCalled();
  });

  it("opens a call without offering SMS as a separate channel", async () => {
    const html = await renderPage({ channels: "voice" });

    expect(directDestinations(html)).toEqual([`tel:${PHONE}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/call|voice/i)]);
    expect(html).toMatch(/Twilio Voice/);
    expect(html).toMatch(/comic link arrives by text/i);
    expect(html).not.toMatch(/Text up to two photos/i);
  });

  it("removes the SMS-photo-to-Voice instruction when admin disables it", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      voicePhotoMode: "none",
    });

    expect(html).toMatch(/Text up to two photos, then share your idea/i);
    expect(html).not.toMatch(/call from the same number/i);
    expect(html).not.toContain('href="/start/camera"');
    expect(directDestinations(html)).toContain(`tel:${PHONE}`);
  });

  it("offers the optional kiosk to SMS even when Voice photos are off", async () => {
    const smsOnly = await renderPage({
      channels: "sms",
      voicePhotoMode: "none",
      cameraEnabled: true,
    });
    const mixed = await renderPage({
      channels: "sms,voice",
      voicePhotoMode: "none",
      cameraEnabled: true,
    });

    expect(smsOnly).toContain('href="/start/camera"');
    expect(smsOnly).toMatch(/Take photos/i);
    expect(smsOnly).toMatch(/Text up to two photos, then share your idea/i);
    expect(mixed).toContain('href="/start/camera"');
    expect(mixed).not.toMatch(/keep texting or call from the same number/i);
  });

  it("offers the optional kiosk to Voice when photos are enabled", async () => {
    const html = await renderPage({
      channels: "voice",
      voicePhotoMode: "sms",
      cameraEnabled: true,
    });

    expect(html).toContain('href="/start/camera"');
    expect(html).toMatch(/Take photos here, then call from the same number/i);
    expect(html).toMatch(/Or call without photos/i);
    expect(directDestinations(html)).toEqual([`tel:${PHONE}`]);
  });

  it("hides the kiosk when no enabled channel can use its photos", async () => {
    const voiceOnly = await renderPage({
      channels: "voice",
      voicePhotoMode: "none",
      cameraEnabled: true,
    });
    const disabled = await renderPage({
      channels: "sms,voice",
      voicePhotoMode: "camera",
      cameraEnabled: false,
    });

    expect(voiceOnly).not.toContain('href="/start/camera"');
    expect(disabled).not.toContain('href="/start/camera"');
  });

  it("keeps the kiosk unavailable until SMS verification is configured", async () => {
    const html = await renderPage({
      channels: "sms",
      voiceReady: false,
      cameraEnabled: true,
    });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}?body=${START_BODY}`]);
    expect(html).not.toContain('href="/start/camera"');
  });

  it("keeps the call action unavailable until Voice verification is configured", async () => {
    const html = await renderPage({ channels: "sms,voice", voiceReady: false });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}?body=${START_BODY}`]);
    expect(html).not.toContain("Twilio Voice");
    expect(getExperienceSettings).toHaveBeenCalledOnce();
  });

  it("preserves the selected order for actions and gives each channel a QR", async () => {
    const html = await renderPage({ channels: "voice,whatsapp,sms" });

    expect(directDestinations(html)).toEqual([
      `tel:${PHONE}`,
      `https://wa.me/447700900123?text=${START_BODY}`,
      `sms:${PHONE}?body=${START_BODY}`,
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
    expect(getExperienceSettings).not.toHaveBeenCalled();
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
