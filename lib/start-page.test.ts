import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import StartPage from "@/app/start/page";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { getExperienceSettings } from "@/lib/photo-experience-settings";

vi.mock("qrcode.react", async () => {
  const { createElement } = await import("react");
  return {
    QRCodeSVG: ({ value, title }: { value: string; title?: string }) =>
      createElement("svg", { role: "img", "data-qr-value": value },
        createElement("title", null, title)),
  };
});
vi.mock("@/lib/browser-studio-settings", () => ({
  getBrowserStudioEnabled: vi.fn(),
}));
vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: vi.fn(),
}));

const PHONE = "+14155552671";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getBrowserStudioEnabled).mockReset();
  vi.mocked(getExperienceSettings).mockReset();
});

async function renderPage({
  channels = "sms,voice",
  studioEnabled = false,
  phone = PHONE,
  publicOrigin = "https://comics.example",
  voiceReady = true,
  accountSid = "AC" + "a".repeat(32),
  openAiKey = "server-key",
}: {
  channels?: string;
  studioEnabled?: boolean;
  phone?: string;
  publicOrigin?: string;
  voiceReady?: boolean;
  accountSid?: string;
  openAiKey?: string;
} = {}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", phone);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+447700900123");
  vi.stubEnv("PUBLIC_BASE_URL", publicOrigin);
  vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? "VA" + "b".repeat(32) : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  vi.stubEnv("AUTH_SECRET", "guest-secret");
  vi.stubEnv("OPENAI_API_KEY", openAiKey);
  vi.stubEnv("MEDIA_SIGNING_SECRET", "media-secret");
  vi.stubEnv("AZURE_STORAGE_CONTAINER_NAME", "comics");
  vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "https://storage.example");
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  vi.stubEnv("AUTH_GOOGLE_ID", "");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "");
  vi.stubEnv("STUDIO_TESTER_EMAILS", "");
  vi.mocked(getBrowserStudioEnabled).mockResolvedValue(studioEnabled);
  vi.mocked(getExperienceSettings).mockResolvedValue({
    voicePhotoMode: "sms",
    cameraEnabled: true,
  });
  return renderToStaticMarkup(await StartPage());
}

function cards(html: string): string[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0]);
}

describe("public start choices", () => {
  it("shows exactly SMS, SMS + Voice, and Browser Studio when enabled", async () => {
    const html = await renderPage({ channels: "sms,voice,whatsapp", studioEnabled: true });
    const choices = cards(html);
    expect(choices).toHaveLength(3);
    expect(choices[0]).toContain("Twilio SMS");
    expect(choices[1]).toContain("SMS + Voice");
    expect(choices[2]).toContain("Browser Studio");
    expect(choices[2]).toContain('href="/studio"');
    expect(choices[2]).toContain('data-qr-value="https://comics.example/studio"');
    expect(html).not.toContain('href="/start/camera"');
    expect(html).not.toContain("Twilio WhatsApp");
    expect(html).not.toMatch(/Google sign-in|approved testers/i);
  });

  it("offers browser play without Twilio channels or Google credentials", async () => {
    const html = await renderPage({
      channels: "",
      studioEnabled: true,
      accountSid: "",
    });
    expect(cards(html)).toHaveLength(1);
    expect(cards(html)[0]).toContain('href="/studio"');
    expect(html).toMatch(/take or upload/i);
    expect(html).not.toMatch(/Message frequency varies/i);
    expect(getExperienceSettings).not.toHaveBeenCalled();
  });

  it("keeps Browser Studio out of the chooser when the admin turns it off", async () => {
    const html = await renderPage({ studioEnabled: false });
    expect(cards(html)).toHaveLength(2);
    expect(html).not.toContain('href="/studio"');
  });

  it("hides Browser Studio if the server cannot create comics", async () => {
    const html = await renderPage({ studioEnabled: true, openAiKey: "" });
    expect(cards(html)).toHaveLength(2);
    expect(html).not.toContain('href="/studio"');
  });

  it("offers Voice only with an SMS photo path and Voice verification", async () => {
    const voiceOnly = await renderPage({ channels: "voice" });
    const unverified = await renderPage({ channels: "sms,voice", voiceReady: false });
    expect(cards(voiceOnly)).toHaveLength(0);
    expect(cards(unverified)).toHaveLength(1);
    expect(unverified).not.toContain('href="/start/voice"');
  });

  it("sends Voice taps and scans to the photo-first guide", async () => {
    const html = await renderPage();
    const voice = cards(html)[1];
    expect(voice).toContain('href="/start/voice"');
    expect(voice).toContain('data-qr-value="https://comics.example/start/voice"');
    expect(voice).toMatch(/photos?.*before.*call/i);
    expect(voice).not.toContain('href="tel:');
  });

  it("makes SMS photo intake and one text disclosure visible", async () => {
    const html = await renderPage();
    expect(cards(html)[0]).toMatch(/attach.*photos?.*send/i);
    expect(html).toContain('href="sms:' + PHONE + '?body=Turn%20me%20into%20a%20comic!"');
    expect(html.match(/Message frequency varies/g)).toHaveLength(1);
    expect(html).toMatch(/Reply HELP for help or STOP to opt out/i);
  });

  it("does not advertise any channel with an invalid public origin", async () => {
    const html = await renderPage({
      channels: "sms,voice",
      studioEnabled: true,
      publicOrigin: "not-a-url",
    });
    expect(cards(html)).toHaveLength(0);
    expect(html).toMatch(/opening soon/i);
    expect(html).not.toContain('data-qr-value=');
  });

  it("keeps the start page closed when no option is selected", async () => {
    const html = await renderPage({ channels: "", studioEnabled: false });
    expect(cards(html)).toHaveLength(0);
    expect(html).toMatch(/opening soon/i);
  });
});
