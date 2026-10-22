import twilio from "twilio";

export type TwilioMessageChannel = "sms" | "whatsapp";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} environment variable is not set`);
  return value;
}

function client() {
  return twilio(required("TWILIO_ACCOUNT_SID"), required("TWILIO_AUTH_TOKEN"));
}

export interface InboundMessage {
  messageSid: string;
  channel: TwilioMessageChannel;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
}

export function parseInboundMessage(
  params: Record<string, string>,
): InboundMessage {
  const numMedia = parseInt(params.NumMedia || "0", 10) || 0;
  const mediaUrls: string[] = [];
  const mediaContentTypes: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) {
      mediaUrls.push(url);
      mediaContentTypes.push(
        params[`MediaContentType${i}`] || "application/octet-stream",
      );
    }
  }
  return {
    messageSid: params.MessageSid || params.SmsMessageSid || "",
    channel: (params.From || "").toLowerCase().startsWith("whatsapp:")
      ? "whatsapp"
      : "sms",
    from: params.From || "",
    to: params.To || "",
    body: (params.Body || "").trim(),
    mediaUrls,
    mediaContentTypes,
  };
}

export const parseInboundSms = parseInboundMessage;

export function validateTwilioSignature({
  signature,
  url,
  params,
}: {
  signature: string | null;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!signature) return false;
  return twilio.validateRequest(required("TWILIO_AUTH_TOKEN"), signature, url, params);
}

function whatsappAddress(address: string): string {
  return address.toLowerCase().startsWith("whatsapp:")
    ? address
    : `whatsapp:${address}`;
}

export async function sendChannelMessage({
  channel,
  to,
  from,
  body,
  mediaUrl,
  statusCallback,
  validityPeriod,
}: {
  channel: TwilioMessageChannel;
  to: string;
  from?: string;
  body: string;
  mediaUrl?: string;
  statusCallback?: string;
  /** SMS/MMS queue lifetime in seconds; omit for ordinary replies and WhatsApp. */
  validityPeriod?: number;
}): Promise<string> {
  const resolvedTo = channel === "whatsapp" ? whatsappAddress(to) : to;
  const defaultFrom = from ||
    (channel === "whatsapp"
      ? required("TWILIO_WHATSAPP_NUMBER")
      : required("TWILIO_PHONE_NUMBER"));
  const resolvedFrom =
    channel === "whatsapp" ? whatsappAddress(from || defaultFrom) : from || defaultFrom;
  const params: {
    to: string;
    from: string;
    body: string;
    mediaUrl?: string[];
    statusCallback?: string;
    validityPeriod?: number;
  } = { to: resolvedTo, from: resolvedFrom, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  if (statusCallback) params.statusCallback = statusCallback;
  if (channel === "sms" && validityPeriod !== undefined) {
    if (!Number.isInteger(validityPeriod) || validityPeriod < 1 || validityPeriod > 36000) {
      throw new Error("validityPeriod must be an integer from 1 to 36000 seconds");
    }
    params.validityPeriod = validityPeriod;
  }

  const message = await client().messages.create(params);
  if (!message.sid) throw new Error("Twilio returned no message SID");
  return message.sid;
}

export async function sendComicMms({
  to,
  body,
  mediaUrl,
}: {
  to: string;
  body: string;
  mediaUrl?: string;
}): Promise<string> {
  return sendChannelMessage({ channel: "sms", to, body, mediaUrl });
}

export async function sendSms({
  to,
  body,
}: {
  to: string;
  body: string;
}): Promise<string> {
  return sendChannelMessage({ channel: "sms", to, body });
}

export async function downloadTwilioMedia(
  mediaUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!isTwilioMediaUrl(mediaUrl)) {
    throw new Error("Untrusted Twilio media URL");
  }
  const signal = AbortSignal.timeout(30_000);
  let url = mediaUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    // Fetch each hop explicitly so API credentials never reach the media CDN
    // or any unexpected redirect destination.
    const hostname = new URL(url).hostname;
    const res = await fetch(url, {
      headers: TWILIO_API_MEDIA_HOSTS.has(hostname)
        ? { Authorization: twilioMediaAuthorization() }
        : undefined,
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Twilio media redirect had no location");
      const destination = new URL(location, url).toString();
      if (!isTwilioMediaUrl(destination)) {
        throw new Error("Untrusted Twilio media redirect");
      }
      if (redirects === 3) throw new Error("Too many Twilio media redirects");
      url = destination;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Failed to download Twilio media: HTTP ${res.status}`);
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_TWILIO_MEDIA_BYTES) {
      throw new Error("Twilio media exceeds the 10 MiB limit");
    }
    if (!res.body) throw new Error("Twilio media response had no body");

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TWILIO_MEDIA_BYTES) {
          throw new Error("Twilio media exceeds the 10 MiB limit");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return {
      buffer: Buffer.concat(chunks, size),
      contentType: res.headers.get("content-type") || "image/jpeg",
    };
  }
  throw new Error("Too many Twilio media redirects");
}

const MAX_TWILIO_MEDIA_BYTES = 10 * 1024 * 1024;
const TWILIO_API_MEDIA_HOSTS = new Set([
  "api.twilio.com",
  "api.us1.twilio.com",
  "api.ashburn.us1.twilio.com",
  "api.dublin.ie1.twilio.com",
  "api.sydney.au1.twilio.com",
]);
const TWILIO_MEDIA_CDN_HOST = "mms.twiliocdn.com";

function twilioMediaAuthorization(): string {
  const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  if (Boolean(apiKeySid) !== Boolean(apiKeySecret)) {
    throw new Error("TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together");
  }
  const mediaUsername = apiKeySid || required("TWILIO_ACCOUNT_SID");
  const mediaPassword = apiKeySecret || required("TWILIO_AUTH_TOKEN");
  return (
    "Basic " +
    Buffer.from(`${mediaUsername}:${mediaPassword}`).toString("base64")
  );
}

/** Accept only documented Twilio API/media hosts before sending media credentials. */
export function isTwilioMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (TWILIO_API_MEDIA_HOSTS.has(url.hostname) ||
        url.hostname === TWILIO_MEDIA_CDN_HOST) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
