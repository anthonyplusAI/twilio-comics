const E164 = /^\+[1-9]\d{7,14}$/;
const EXAMPLE_NUMBER = "+15551234567";

export interface MarketingContact {
  phoneNumber: string | null;
  whatsappNumber: string | null;
  smsHref: string | null;
  callHref: string | null;
  whatsappHref: string | null;
}

export type MarketingChannel = "sms" | "whatsapp" | "voice";

function isMarketingChannel(value: string): value is MarketingChannel {
  return value === "sms" || value === "whatsapp" || value === "voice";
}

export function getEnabledChannels(
  contact: MarketingContact,
  raw: string | undefined,
): MarketingChannel[] {
  const requested = raw?.split(",") ?? [];
  const enabled: MarketingChannel[] = [];

  for (const token of requested) {
    const channel = token.trim().toLowerCase();
    if (!isMarketingChannel(channel) || enabled.includes(channel)) continue;
    if (channel === "whatsapp" ? !contact.whatsappNumber : !contact.phoneNumber) continue;
    enabled.push(channel);
  }

  return enabled;
}

function publicPhoneNumber(value: string | undefined): string | null {
  const number = value?.trim();

  if (!number || number === EXAMPLE_NUMBER || !E164.test(number)) {
    return null;
  }

  return number;
}

export function getMarketingContact(
  smsAndVoiceNumber: string | undefined,
  whatsappSender: string | undefined,
): MarketingContact {
  const phoneNumber = publicPhoneNumber(smsAndVoiceNumber);
  const trimmedWhatsAppSender = whatsappSender?.trim();
  const whatsappNumber = trimmedWhatsAppSender?.startsWith("whatsapp:")
    ? publicPhoneNumber(trimmedWhatsAppSender.slice("whatsapp:".length))
    : null;

  return {
    phoneNumber,
    whatsappNumber,
    smsHref: phoneNumber ? `sms:${phoneNumber}` : null,
    callHref: phoneNumber ? `tel:${phoneNumber}` : null,
    whatsappHref: whatsappNumber
      ? `https://wa.me/${whatsappNumber.slice(1)}`
      : null,
  };
}
