import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

const PHONE = "+14155552671";
const WHATSAPP = "whatsapp:+447700900123";
const SMS_HREF = `sms:${PHONE}?body=Turn%20me%20into%20a%20comic!`;
const WHATSAPP_HREF = "https://wa.me/447700900123?text=Turn%20me%20into%20a%20comic!";

afterEach(() => vi.unstubAllEnvs());

function renderPage(channels: string | undefined, voiceReady = true): string {
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", WHATSAPP);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", voiceReady ? `VA${"b".repeat(32)}` : "");
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
  return renderToStaticMarkup(createElement(Home));
}

describe("Twilio channel invitation", () => {
  it("discloses the SMS program and Voice result delivery beside the launch actions", () => {
    const html = renderPage("sms,voice");

    expect(html).toContain(`href="${SMS_HREF}"`);
    expect(html).toContain(`href="tel:${PHONE}"`);
    expect(html).not.toContain("https://wa.me/");
    expect(html).toMatch(/Message frequency varies/i);
    expect(html).toMatch(/Message and data rates may apply/i);
    expect(html).toMatch(/Reply HELP for help or STOP to opt out/i);
    const actionEnd = html.indexOf(`href="tel:${PHONE}"`);
    const disclosure = html.indexOf("Message frequency varies");
    const heroEnd = html.indexOf("</section>");
    expect(disclosure).toBeGreaterThan(actionEnd);
    expect(disclosure).toBeLessThan(heroEnd);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toMatch(/phone that (?:can )?receive SMS|number you call from/i);
    expect(html).toMatch(/code.+keypad/i);
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/privacy"');
    expect(html).toContain('href="https://www.twilio.com/en-us/legal/tos"');
  });

  it("shows only SMS entry and SMS flow when SMS is selected", () => {
    const html = renderPage("sms");

    expect(html).toContain(`href="${SMS_HREF}"`);
    expect(html).not.toContain("?body=NEW");
    expect(html).toMatch(/send up to two photos before or with your idea/i);
    expect(html).not.toMatch(/send NEW to start/i);
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain("https://wa.me/");
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toMatch(/send CREATE/);
    expect(html).toMatch(/comic link[^<]*by SMS/);
    expect(html).not.toMatch(/say .create it./i);
    expect(html).toContain("Scan to text");
  });

  it("shows only a call entry and explains SMS delivery when Voice is selected", () => {
    const html = renderPage("voice");

    expect(html).toContain(`href="tel:${PHONE}"`);
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain("https://wa.me/");
    expect(html).toMatch(/Twilio Voice/);
    expect(html).toMatch(/ConversationRelay/);
    expect(html).toMatch(/say .create it./i);
    expect(html).toMatch(/comic link[^<]*by SMS/);
    expect(html).not.toMatch(/reference photos/);
    expect(html).toContain("Scan to call");
  });

  it("does not advertise a Voice action before verification is configured", () => {
    const html = renderPage("sms,voice", false);

    expect(html).toContain(`href="${SMS_HREF}"`);
    expect(html).not.toContain(`href="tel:${PHONE}"`);
  });

  it("shows only WhatsApp entry and chat delivery when WhatsApp is selected", () => {
    const html = renderPage("whatsapp");

    expect(html).toContain(`href="${WHATSAPP_HREF}"`);
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).toMatch(/Twilio WhatsApp/);
    expect(html).not.toContain("?text=NEW");
    expect(html).toMatch(/send up to two photos before or with your idea/i);
    expect(html).not.toMatch(/send NEW to start/i);
    expect(html).toMatch(/send CREATE/);
    expect(html).toMatch(/comic link[^<]*same WhatsApp chat/);
    expect(html).toContain("Scan to message an idea or photos");
  });

  it("shows instructions for every selected channel and uses the first for QR", () => {
    const html = renderPage("voice,whatsapp,sms");

    expect(html).toContain(`href="tel:${PHONE}"`);
    expect(html).toContain(`href="${SMS_HREF}"`);
    expect(html).toContain(`href="${WHATSAPP_HREF}"`);
    expect(html).toMatch(/Twilio Voice/);
    expect(html).toMatch(/Twilio WhatsApp/);
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toContain("Scan to call");
  });

  it("links to the dedicated channel chooser", () => {
    const html = renderPage("sms,whatsapp,voice");

    expect(html).toContain('href="/start"');
  });

  it("limits photo guidance to the enabled messaging channel", () => {
    const html = renderPage("voice,whatsapp");

    expect(html).toContain("WhatsApp messages can include up to two reference photos");
    expect(html).not.toContain("SMS and WhatsApp messages");
    expect(html).not.toContain('href="sms:');
  });

  it("does not advertise a start action for an explicit empty selection", () => {
    const html = renderPage("");

    expect(html).toContain("Opening soon");
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain("https://wa.me/");
    expect(html).not.toContain("Scan to");
  });

  it("does not advertise contact actions when channel selection is missing despite valid senders", () => {
    const html = renderPage(undefined);

    expect(html).toContain("Opening soon");
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain("https://wa.me/");
    expect(html).not.toContain("Scan to");
  });
});
