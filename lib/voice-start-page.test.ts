import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceStartPage from "@/app/start/voice/page";
import { getCameraDestination } from "@/lib/browser-photo-access";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import type { VoicePhotoMode } from "@/lib/schema";

vi.mock("@/lib/browser-photo-access", () => ({
  getCameraDestination: vi.fn(),
}));
vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: vi.fn(),
}));

const PHONE = "+18669012028";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getCameraDestination).mockReset();
  vi.mocked(getExperienceSettings).mockReset();
});

async function renderPage({
  channels = "sms,voice",
  mode = "sms",
  cameraEnabled = false,
  cameraAvailable = false,
  voiceReady = true,
}: {
  channels?: string;
  mode?: VoicePhotoMode;
  cameraEnabled?: boolean;
  cameraAvailable?: boolean;
  voiceReady?: boolean;
} = {}): Promise<string> {
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? `VA${"b".repeat(32)}` : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example");
  vi.mocked(getExperienceSettings).mockResolvedValue({ voicePhotoMode: mode, cameraEnabled });
  vi.mocked(getCameraDestination).mockResolvedValue(cameraAvailable ? {
    phoneNumber: PHONE,
    smsHref: `sms:${PHONE}?body=Turn%20me%20into%20a%20comic!`,
    callHref: `tel:${PHONE}`,
  } : null);
  return renderToStaticMarkup(await VoiceStartPage());
}

describe("Voice preparation page", () => {
  it("keeps texted photos first even when browser photos are enabled", async () => {
    const html = await renderPage({ mode: "camera", cameraEnabled: true, cameraAvailable: true });

    expect(html).toMatch(/Add photos before (you|your) call/i);
    expect(html).toContain(`href="sms:${PHONE}"`);
    expect(html).toContain('href="/start/camera"');
    expect(html.indexOf(`href="sms:${PHONE}"`)).toBeLessThan(html.indexOf('href="/start/camera"'));
    expect(html.indexOf('href="/start/camera"')).toBeLessThan(html.indexOf(`href="tel:${PHONE}"`));
    expect(html).toMatch(/wait for .*photo saved.*reply/i);
    expect(html).toMatch(/within 24 hours/i);
    expect(vi.mocked(getCameraDestination)).toHaveBeenCalledWith({
      voicePhotoMode: "camera",
      cameraEnabled: true,
    });
  });

  it("offers browser photos as a secondary option when MMS is available", async () => {
    const html = await renderPage({ mode: "sms", cameraEnabled: true, cameraAvailable: true });

    expect(html).toContain(`href="sms:${PHONE}"`);
    expect(html).toContain('href="/start/camera"');
    expect(html.indexOf(`href="sms:${PHONE}"`)).toBeLessThan(html.indexOf(`href="tel:${PHONE}"`));
    expect(html.indexOf(`href="sms:${PHONE}"`)).toBeLessThan(html.indexOf('href="/start/camera"'));
  });

  it("falls back to the working photo source when the preferred one is unavailable", async () => {
    const smsFallback = await renderPage({ mode: "camera", cameraEnabled: true });
    expect(smsFallback).toContain(`href="sms:${PHONE}"`);
    expect(smsFallback).not.toContain('href="/start/camera"');

    const browserFallback = await renderPage({
      channels: "voice",
      mode: "sms",
      cameraEnabled: true,
      cameraAvailable: true,
    });
    expect(browserFallback).toContain('href="/start/camera"');
    expect(browserFallback).not.toContain(`href="sms:${PHONE}"`);
  });

  it("offers an empty MMS draft before the call when browser upload is off", async () => {
    const html = await renderPage();

    expect(html).toMatch(/Attach (one|1) or two photos/i);
    expect(html).toContain(`href="sms:${PHONE}"`);
    expect(html).not.toContain(`href="sms:${PHONE}?body=`);
    expect(html).toMatch(/wait for .*photo saved.*reply/i);
    expect(html).toMatch(/within 24 hours/i);
    expect(html).toMatch(/call from the same (phone|number)/i);
    expect(html).toMatch(/six-digit code/i);
    expect(html).toMatch(/phone.*keypad/i);
    expect(html).toMatch(/listen to the recap/i);
    expect(html).toMatch(/say .*create it/i);
    expect(html).toMatch(/comic link arrives by text/i);
    expect(html.indexOf('id="photos-step-title"')).toBeLessThan(html.indexOf('id="call-step-title"'));
    expect(html.indexOf('id="call-step-title"')).toBeLessThan(html.indexOf('id="idea-step-title"'));
    expect(html.indexOf(`href="sms:${PHONE}"`)).toBeLessThan(html.indexOf(`href="tel:${PHONE}"`));
    expect(html).not.toContain('href="/start/camera"');
  });

  it("explains when Voice photos are disabled and offers SMS as the personalized path", async () => {
    const html = await renderPage({ mode: "none", cameraEnabled: true, cameraAvailable: true });

    expect(html).toMatch(/Voice.*(cannot|won.t).*use reference photos/i);
    expect(html).toContain(`href="sms:${PHONE}?body=Turn%20me%20into%20a%20comic!"`);
    expect(html).not.toContain(`href="tel:${PHONE}"`);
    expect(html).not.toContain('href="/start/camera"');
    expect(vi.mocked(getCameraDestination)).not.toHaveBeenCalled();
  });

  it("does not promise photo intake to a Voice-only setup with no upload path", async () => {
    const html = await renderPage({ channels: "voice" });

    expect(html).toMatch(/reference photos.*(unavailable|cannot)/i);
    expect(html).not.toContain(`href="tel:${PHONE}"`);
    expect(html).not.toContain(`href="sms:${PHONE}`);
  });

  it("shows no contact action when the Voice channel is unavailable", async () => {
    for (const options of [{ channels: "sms" }, { voiceReady: false }]) {
      const html = await renderPage(options);
      expect(html).toMatch(/Voice.*unavailable/i);
      expect(html).toContain('href="/start"');
      expect(html).not.toMatch(/href="(?:sms:|tel:)/);
      expect(vi.mocked(getExperienceSettings)).not.toHaveBeenCalled();
    }
  });
});
