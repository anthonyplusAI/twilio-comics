import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import StartPage from "@/app/start/page";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import type { VoicePhotoMode } from "@/lib/schema";

vi.mock("qrcode.react", async () => {
  const { createElement } = await import("react");
  return {
    QRCodeSVG: ({ value, title }: { value: string; title?: string }) =>
      createElement("svg", { role: "img", "data-qr-value": value },
        createElement("title", null, title)),
  };
});

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
  studioEnabled = false,
  studioTesters = "tester@example.com",
  origin = "https://comics.example",
  accountSid = `AC${"a".repeat(32)}`,
  authToken = "test-token",
}: {
  channels: string | undefined;
  phone?: string;
  whatsapp?: string;
  voiceReady?: boolean;
  voicePhotoMode?: VoicePhotoMode;
  cameraEnabled?: boolean;
  studioEnabled?: boolean;
  studioTesters?: string;
  origin?: string;
  accountSid?: string;
  authToken?: string;
}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", phone);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", whatsapp);
  vi.stubEnv("PUBLIC_BASE_URL", origin);
  vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", studioEnabled ? "studio-google-client" : "");
  vi.stubEnv("AUTH_GOOGLE_SECRET", studioEnabled ? "studio-google-secret" : "");
  vi.stubEnv("STUDIO_TESTER_EMAILS", studioTesters);
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
  it("lists each enabled start path, including browser photos and Studio", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      cameraEnabled: true,
      studioEnabled: true,
    });
    const cards = cardMarkup(html);

    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain("Twilio SMS");
    expect(cards[1]).toContain("Twilio Voice");
    expect(cards[2]).toContain("Browser photo page");
    expect(cards[2]).toContain('href="/start/camera"');
    expect(cards[2]).toContain('data-qr-value="https://comics.example/start/camera"');
    expect(cards[3]).toContain("Browser Studio");
    expect(cards[3]).toContain('href="/studio"');
    expect(cards[3]).toContain('data-qr-value="https://comics.example/studio"');
    expect(cards[3]).toMatch(/Google sign-in/i);
  });

  it("offers Studio on its own when Google sign-in is ready", async () => {
    const html = await renderPage({ channels: "", studioEnabled: true });

    expect(html).toContain("Choose how to start.");
    expect(cardMarkup(html)).toHaveLength(1);
    expect(cardMarkup(html)[0]).toContain('href="/studio"');
    expect(html).not.toMatch(/Message frequency varies|Reply HELP for help/i);
    expect(getExperienceSettings).not.toHaveBeenCalled();
  });

  it("hides Studio when its production tester allowlist is empty", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = await renderPage({
      channels: "sms",
      studioEnabled: true,
      studioTesters: " , ",
    });

    expect(cardMarkup(html)).toHaveLength(1);
    expect(html).not.toContain('href="/studio"');
  });

  it("labels the production Studio as restricted to approved testers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = await renderPage({ channels: "", studioEnabled: true });

    expect(cardMarkup(html)).toHaveLength(1);
    expect(cardMarkup(html)[0]).toMatch(/Approved testers only/);
    expect(cardMarkup(html)[0]).toMatch(/approved Google account/);
  });

  it("does not advertise unavailable phone or browser paths with a bad public origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = await renderPage({
      channels: "sms,voice,whatsapp",
      cameraEnabled: true,
      studioEnabled: true,
      origin: "not-a-url",
    });

    expect(cardMarkup(html)).toHaveLength(0);
    expect(html).toMatch(/opening soon/i);
    expect(qrTitles(html)).toEqual([]);
  });

  it("keeps Studio available while hiding phone paths with missing Twilio credentials", async () => {
    const withoutAccount = await renderPage({
      channels: "sms,voice,whatsapp",
      studioEnabled: true,
      cameraEnabled: true,
      accountSid: "",
    });
    const withoutToken = await renderPage({
      channels: "sms,voice,whatsapp",
      studioEnabled: true,
      cameraEnabled: true,
      authToken: "",
    });

    for (const html of [withoutAccount, withoutToken]) {
      expect(cardMarkup(html)).toHaveLength(1);
      expect(cardMarkup(html)[0]).toContain('href="/studio"');
      expect(html).not.toMatch(/Message frequency varies/i);
    }
  });

  it("sends Voice scans and taps to photo setup before a call", async () => {
    const html = await renderPage({ channels: "sms,voice" });
    const voiceCard = cardMarkup(html)[1];

    expect(voiceCard).toContain('href="/start/voice"');
    expect(voiceCard).toContain('data-qr-value="https://comics.example/start/voice"');
    expect(voiceCard).toMatch(/photos?.*before.*call/i);
    expect(voiceCard).not.toContain(`href="tel:${PHONE}"`);
  });

  it("makes attaching photos visible on the SMS card", async () => {
    const html = await renderPage({ channels: "sms" });

    expect(cardMarkup(html)[0]).toMatch(/attach.*photos?.*send/i);
  });

  it("shows short SMS and Voice choices with one disclosure below the cards", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      phone: "+18669012028",
      whatsapp: "",
    });

    expect(directDestinations(html)).toEqual([
      `sms:+18669012028?body=${START_BODY}`,
    ]);
    expect(html).toContain('href="/start/voice"');
    expect(html).not.toMatch(/\bNEW\b/);
    expect(html).not.toContain("Twilio WhatsApp");
    expect(html.match(/Message frequency varies/g)).toHaveLength(1);
    expect(html).toMatch(/Automated replies and comic links by text/i);
    expect(html).toMatch(/Message and data rates may apply/i);
    expect(html).toMatch(/Reply HELP for help or STOP to opt out/i);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html.indexOf("Message frequency varies")).toBeGreaterThan(html.lastIndexOf("</article>"));

    const cards = cardMarkup(html);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatch(/Twilio SMS/);
    expect(cards[1]).toMatch(/Twilio Voice/);
    for (const card of cards) {
      expect(card).not.toMatch(/Message frequency|HELP|STOP|comic link|code/i);
    }
    expect(html).toMatch(/Send at least one photo, then an idea/i);
    expect(html).toMatch(/Save photos first, then call from the same number/i);
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });

  it("keeps instructions outside the cards in a collapsed guide", async () => {
    const html = await renderPage({ channels: "sms,voice" });

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("Choose how to start.");
    expect(html).toMatch(/<details\b[\s\S]*?<summary>How it works<\/summary>/);
    expect(html).toMatch(/Confirm the SMS code and tell the agent your idea/i);
    expect(cardMarkup(html).join(" ")).not.toMatch(/How it works|SMS code/i);
    expect(html).toMatch(/Forked from[^<]*<a[^>]*>Make Comics<\/a>/);
  });

  it("opens SMS from the only enabled channel", async () => {
    const html = await renderPage({ channels: "sms" });

    expect(directDestinations(html)).toEqual([`sms:${PHONE}?body=${START_BODY}`]);
    expect(qrTitles(html)).toEqual([expect.stringMatching(/text|sms/i)]);
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toContain(PHONE);
    expect(html).toMatch(/Send at least one photo, then an idea/i);
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

  it("does not offer Voice when no reference photo intake is available", async () => {
    const html = await renderPage({ channels: "voice" });

    expect(directDestinations(html)).toEqual([]);
    expect(qrTitles(html)).toEqual([]);
    expect(html).not.toMatch(/Twilio Voice/);
    expect(html).toMatch(/Calls need reference photos/i);
  });

  it("removes the SMS-photo-to-Voice instruction when admin disables it", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      voicePhotoMode: "none",
    });

    expect(html).toMatch(/Send at least one photo, then an idea/i);
    expect(html).not.toMatch(/call from the same number/i);
    expect(html).not.toContain('href="/start/camera"');
    expect(directDestinations(html)).toEqual([`sms:${PHONE}?body=${START_BODY}`]);
    expect(html).not.toContain("Twilio Voice");
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
    expect(smsOnly).toMatch(/Browser photo page/i);
    expect(smsOnly).toMatch(/take or upload one or two photos, then text from that number/i);
    expect(mixed).toContain('href="/start/camera"');
    expect(mixed).toMatch(/take or upload one or two photos, then text from that number/i);
    expect(mixed).not.toContain("Twilio Voice");
  });

  it("explains the photo options without requiring both when SMS and Voice are active", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      voicePhotoMode: "sms",
      cameraEnabled: true,
    });

    expect(cardMarkup(html)).toHaveLength(3);
    expect(cardMarkup(html)[0]).toMatch(/Attach one or two reference photos/i);
    expect(cardMarkup(html)[1]).toMatch(/photos before calling from the same number/i);
    expect(cardMarkup(html)[2]).toMatch(/then text or call from that number/i);
  });

  it("offers the optional kiosk to Voice when photos are enabled", async () => {
    const html = await renderPage({
      channels: "voice",
      voicePhotoMode: "sms",
      cameraEnabled: true,
    });

    expect(html).toContain('href="/start/camera"');
    expect(html).toMatch(/take or upload one or two photos, then call from that number/i);
    expect(html).not.toMatch(/Or call without photos/i);
    expect(directDestinations(html)).toEqual([]);
    expect(html).toContain('href="/start/voice"');
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
      `https://wa.me/447700900123?text=${START_BODY}`,
      `sms:${PHONE}?body=${START_BODY}`,
    ]);
    expect(cardMarkup(html)[0]).toContain('href="/start/voice"');
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
