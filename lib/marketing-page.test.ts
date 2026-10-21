import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

const PHONE = "+14155552671";
const WHATSAPP = "whatsapp:+447700900123";

afterEach(() => vi.unstubAllEnvs());

function renderPage(channels: string): string {
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE);
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", WHATSAPP);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", channels);
  return renderToStaticMarkup(createElement(Home));
}

describe("Twilio channel invitation", () => {
  it("shows only SMS entry and SMS flow when SMS is selected", () => {
    const html = renderPage("sms");

    expect(html).toContain(`href="sms:${PHONE}"`);
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

  it("shows only WhatsApp entry and chat delivery when WhatsApp is selected", () => {
    const html = renderPage("whatsapp");

    expect(html).toContain('href="https://wa.me/447700900123"');
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).toMatch(/Twilio WhatsApp/);
    expect(html).toMatch(/send CREATE/);
    expect(html).toMatch(/comic link[^<]*same WhatsApp chat/);
    expect(html).toContain("Scan for WhatsApp");
  });

  it("shows instructions for every selected channel and uses the first for QR", () => {
    const html = renderPage("voice,whatsapp,sms");

    expect(html).toContain(`href="tel:${PHONE}"`);
    expect(html).toContain(`href="sms:${PHONE}"`);
    expect(html).toContain('href="https://wa.me/447700900123"');
    expect(html).toMatch(/Twilio Voice/);
    expect(html).toMatch(/Twilio WhatsApp/);
    expect(html).toMatch(/Twilio SMS/);
    expect(html).toContain("Scan to call");
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
});
