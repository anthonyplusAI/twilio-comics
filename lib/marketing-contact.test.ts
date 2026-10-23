import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";

vi.mock("qrcode.react", async () => {
  const { createElement } = await import("react");
  return {
    QRCodeSVG: ({ value, title }: { value: string; title?: string }) =>
      createElement("svg", { "data-test-qr-value": value, title }),
  };
});

afterEach(() => vi.unstubAllEnvs());

describe("getMarketingContact", () => {
  it("keeps public actions unavailable for missing or example senders", () => {
    expect(getMarketingContact(undefined, undefined)).toEqual({
      phoneNumber: null,
      whatsappNumber: null,
      smsHref: null,
      callHref: null,
      whatsappHref: null,
    });
    expect(
      getMarketingContact("+15551234567", "whatsapp:+15551234567"),
    ).toEqual({
      phoneNumber: null,
      whatsappNumber: null,
      smsHref: null,
      callHref: null,
      whatsappHref: null,
    });
  });

  it("creates direct actions only for valid configured channels", () => {
    expect(
      getMarketingContact(" +14155552671 ", "whatsapp:+447700900123"),
    ).toEqual({
      phoneNumber: "+14155552671",
      whatsappNumber: "+447700900123",
      smsHref: "sms:+14155552671?body=Turn%20me%20into%20a%20comic!",
      callHref: "tel:+14155552671",
      whatsappHref: "https://wa.me/447700900123?text=Turn%20me%20into%20a%20comic!",
    });
    expect(getMarketingContact("+14155552671", undefined).whatsappHref).toBeNull();
  });

  it("exposes a configured WhatsApp sender without requiring an SMS and Voice number", () => {
    expect(getMarketingContact(undefined, " whatsapp:+447700900123 ")).toEqual({
      phoneNumber: null,
      whatsappNumber: "+447700900123",
      smsHref: null,
      callHref: null,
      whatsappHref: "https://wa.me/447700900123?text=Turn%20me%20into%20a%20comic!",
    });
  });

  it("rejects malformed numbers and an unprefixed WhatsApp sender", () => {
    expect(getMarketingContact("555-1234", "+447700900123")).toEqual({
      phoneNumber: null,
      whatsappNumber: null,
      smsHref: null,
      callHref: null,
      whatsappHref: null,
    });
  });
});

describe("getEnabledChannels", () => {
  const both = getMarketingContact("+14155552671", "whatsapp:+447700900123");

  it("keeps every channel closed when the selection is omitted, even with valid senders", () => {
    expect(getEnabledChannels(both, undefined)).toEqual([]);
    expect(getEnabledChannels(getMarketingContact("+14155552671", undefined), undefined))
      .toEqual([]);
    expect(getEnabledChannels(getMarketingContact(undefined, "whatsapp:+447700900123"), undefined))
      .toEqual([]);
  });

  it("treats an explicitly empty selection as no enabled channels", () => {
    expect(getEnabledChannels(both, "")).toEqual([]);
    expect(getEnabledChannels(both, " , ")).toEqual([]);
  });

  it("normalizes selected channels and preserves their first listed order", () => {
    expect(getEnabledChannels(both, " VOICE , whatsapp, SMS, voice,Unknown,SMS "))
      .toEqual(["voice", "whatsapp", "sms"]);
  });

  it("does not enable selected channels without validated destinations", () => {
    const whatsappOnly = getMarketingContact("+15551234567", "whatsapp:+447700900123");
    expect(getEnabledChannels(whatsappOnly, "voice,sms,whatsapp"))
      .toEqual(["whatsapp"]);
    expect(getEnabledChannels(getMarketingContact(undefined, undefined), "sms,whatsapp,voice"))
      .toEqual([]);
  });
});

describe("public comic invitation", () => {
  it("sends visitors to the channel chooser even when only WhatsApp is enabled", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com/");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");
    vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+447700900123");
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "whatsapp");

    const html = renderToStaticMarkup(createElement(Home));

    expect(html.match(/href="\/start"/g)).toHaveLength(1);
    expect(html).toContain('data-test-qr-value="https://comics.example.com/start"');
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('href="https://wa.me/');
  });

  it("keeps the chooser link and QR available without a configured sender", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");
    vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "");
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "");

    const html = renderToStaticMarkup(createElement(Home));

    expect(html.match(/href="\/start"/g)).toHaveLength(1);
    expect(html).toContain('data-test-qr-value="https://comics.example.com/start"');
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('href="https://wa.me/');
  });
});
