import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceStartPage from "@/app/start/voice/page";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import type { VoicePhotoMode } from "@/lib/schema";

vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: vi.fn(),
}));

const PHONE = "+18669012028";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getExperienceSettings).mockReset();
});

async function renderPage({
  channels = "sms,voice",
  mode = "sms",
  cameraEnabled = false,
  voiceReady = true,
}: {
  channels?: string;
  mode?: VoicePhotoMode;
  cameraEnabled?: boolean;
  voiceReady?: boolean;
} = {}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC" + "a".repeat(32));
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? "VA" + "b".repeat(32) : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
  vi.mocked(getExperienceSettings).mockResolvedValue({ voicePhotoMode: mode, cameraEnabled });
  return renderToStaticMarkup(await VoiceStartPage());
}

describe("SMS + Voice preparation page", () => {
  it("leads with texted photos even when legacy browser staging is enabled", async () => {
    const html = await renderPage({ cameraEnabled: true });
    expect(html).toMatch(/Add photos before (you|your) call/i);
    expect(html).toContain('href="sms:' + PHONE + '?body=Photos%20then%20call"');
    expect(html).toMatch(/if messages opens blank.*type.*photos then call/i);
    expect(html).toMatch(/wait for .*photo saved.*(phone number|number)/i);
    expect(html).toMatch(/within 24 hours/i);
    expect(html).not.toContain('href="/start/camera"');
    expect(html.indexOf('href="sms:' + PHONE + '?body=Photos%20then%20call"')).toBeLessThan(
      html.indexOf('href="tel:' + PHONE + '"'),
    );
  });

  it("guides the code, approval, and SMS delivery in that order", async () => {
    const html = await renderPage();
    expect(html).toMatch(/six-digit code/i);
    expect(html).toMatch(/phone.*keypad/i);
    expect(html).toMatch(/listen to the recap/i);
    expect(html).toMatch(/say .*create it/i);
    expect(html).toMatch(/comic link arrives by text/i);
    expect(html.indexOf('id="photos-step-title"')).toBeLessThan(html.indexOf('id="call-step-title"'));
    expect(html.indexOf('id="call-step-title"')).toBeLessThan(html.indexOf('id="idea-step-title"'));
  });

  it("does not offer a call when SMS photo intake is unavailable", async () => {
    const html = await renderPage({ channels: "voice", cameraEnabled: true });
    expect(html).toMatch(/reference photos.*(unavailable|cannot)/i);
    expect(html).not.toContain('href="tel:' + PHONE + '"');
    expect(html).not.toContain('href="sms:' + PHONE + '"');
    expect(html).not.toContain('href="/start/camera"');
  });

  it("explains a disabled Voice photo mode without suggesting the old camera page", async () => {
    const html = await renderPage({ mode: "none", cameraEnabled: true });
    expect(html).toMatch(/Voice.*(cannot|won.t).*use reference photos/i);
    expect(html).toContain('href="sms:' + PHONE + '?body=Turn%20me%20into%20a%20comic!"');
    expect(html).not.toContain('href="tel:' + PHONE + '"');
    expect(html).not.toContain('href="/start/camera"');
  });

  it("shows no contact action when Voice verification is unavailable", async () => {
    const html = await renderPage({ voiceReady: false });
    expect(html).toMatch(/Voice.*unavailable/i);
    expect(html).not.toMatch(/href="(?:sms:|tel:)/);
    expect(getExperienceSettings).not.toHaveBeenCalled();
  });
});
