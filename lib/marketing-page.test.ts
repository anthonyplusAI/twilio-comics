import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

const SITE_ORIGIN = "https://comics.example";

afterEach(() => vi.unstubAllEnvs());

function renderPage(channels: string | undefined): string {
  vi.stubEnv("PUBLIC_BASE_URL", `${SITE_ORIGIN}/`);
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+14155552671");
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+447700900123");
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"b".repeat(32)}`);
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  return renderToStaticMarkup(createElement(Home));
}

function qrForegroundPath(markup: string): string | undefined {
  const qrSvg = markup.match(/<svg\b[^>]*role="img"[^>]*>[\s\S]*?<\/svg>/)?.[0];
  return qrSvg?.match(/<path\b[^>]*\bd="([^"]+)"[^>]*><\/path>/g)
    ?.at(-1)
    ?.match(/\bd="([^"]+)"/)?.[1];
}

function expectSingleChooserEntry(html: string): void {
  expect(html.match(/href="\/start"/g)).toHaveLength(1);
  expect(html).not.toMatch(/href="(?:sms:|tel:|https:\/\/wa\.me\/)/);

  const expectedQr = renderToStaticMarkup(createElement(QRCodeSVG, {
    value: `${SITE_ORIGIN}/start`,
    level: "M",
    includeMargin: true,
  }));
  expect(qrForegroundPath(html)).toBeDefined();
  expect(qrForegroundPath(html)).toBe(qrForegroundPath(expectedQr));
  expect(html).toMatch(/<svg\b[^>]*role="img"[^>]*>\s*<title>[^<]*(?:scan|start|choose)/i);
}

describe("marketing homepage entry point", () => {
  it.each([
    "sms",
    "voice",
    "whatsapp",
    "sms,voice",
    "voice,whatsapp,sms",
  ])("sends visitors to /start before choosing the %s experience", (channels) => {
    expectSingleChooserEntry(renderPage(channels));
  });

  it.each([undefined, ""])(
    "keeps /start available when the channel selection is %s",
    (channels) => {
      expectSingleChooserEntry(renderPage(channels));
    },
  );

  it("keeps the project credit and policy links on the attractor page", () => {
    const html = renderPage("sms,voice");

    expect(html).toContain("Twilio Comics");
    expect(html).toContain('href="https://github.com/Nutlope/make-comics"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });

  it("places the start QR beside the main action before the comic preview", () => {
    const html = renderPage("sms,voice");

    expect(html.indexOf("Scan to choose how to start"))
      .toBeGreaterThan(html.indexOf("Choose how to start"));
    expect(html.indexOf("Scan to choose how to start"))
      .toBeLessThan(html.indexOf("Imagine what yours could be"));
  });
});
