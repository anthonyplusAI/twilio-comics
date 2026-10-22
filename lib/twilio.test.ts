import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  validateRequest: vi.fn(),
  create: vi.fn(),
}));

vi.mock("twilio", () => {
  const twilio: any = vi.fn(() => ({ messages: { create: h.create } }));
  twilio.validateRequest = h.validateRequest;
  return { default: twilio };
});

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_PHONE_NUMBER = "+15550000000";
  process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+14155238886";
  h.validateRequest.mockReset();
  h.create.mockReset();
  h.create.mockResolvedValue({ sid: "SM1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TWILIO_API_KEY_SID;
  delete process.env.TWILIO_API_KEY_SECRET;
});

describe("parseInboundSms", () => {
  it("parses from/body and indexed media", async () => {
    const { parseInboundSms } = await import("@/lib/twilio");
    const r = parseInboundSms({
      From: "+15551112222", To: "+15550000000", Body: "hi",
      MessageSid: "SM1",
      NumMedia: "2", MediaUrl0: "https://u/0", MediaContentType0: "image/jpeg",
      MediaUrl1: "https://u/1", MediaContentType1: "image/png",
    });
    expect(r.from).toBe("+15551112222");
    expect(r.messageSid).toBe("SM1");
    expect(r.channel).toBe("sms");
    expect(r.body).toBe("hi");
    expect(r.mediaUrls).toEqual(["https://u/0", "https://u/1"]);
    expect(r.mediaContentTypes).toEqual(["image/jpeg", "image/png"]);
  });

  it("detects WhatsApp addresses", async () => {
    const { parseInboundMessage } = await import("@/lib/twilio");
    const result = parseInboundMessage({
      MessageSid: "SM2",
      From: "whatsapp:+15551112222",
      To: "whatsapp:+14155238886",
      Body: "hello",
    });
    expect(result.channel).toBe("whatsapp");
  });

  it("handles zero media", async () => {
    const { parseInboundSms } = await import("@/lib/twilio");
    const r = parseInboundSms({ From: "+1", To: "+2", Body: "x", NumMedia: "0" });
    expect(r.mediaUrls).toEqual([]);
  });
});

describe("validateTwilioSignature", () => {
  it("delegates to twilio.validateRequest with auth token, url, params", async () => {
    h.validateRequest.mockReturnValue(true);
    const { validateTwilioSignature } = await import("@/lib/twilio");
    const ok = validateTwilioSignature({ signature: "sig", url: "https://a/api/twilio/sms", params: { From: "+1" } });
    expect(ok).toBe(true);
    expect(h.validateRequest).toHaveBeenCalledWith("tok", "sig", "https://a/api/twilio/sms", { From: "+1" });
  });

  it("returns false when signature header is null", async () => {
    const { validateTwilioSignature } = await import("@/lib/twilio");
    expect(validateTwilioSignature({ signature: null, url: "https://a", params: {} })).toBe(false);
    expect(h.validateRequest).not.toHaveBeenCalled();
  });
});

describe("sendComicMms", () => {
  it("sends an MMS with mediaUrl array when provided", async () => {
    const { sendComicMms } = await import("@/lib/twilio");
    await sendComicMms({ to: "+15551112222", body: "done", mediaUrl: "https://s3/x.png" });
    expect(h.create).toHaveBeenCalledWith({
      to: "+15551112222", from: "+15550000000", body: "done", mediaUrl: ["https://s3/x.png"],
    });
  });

  it("sends plain SMS (no mediaUrl key) when no media", async () => {
    const { sendComicMms } = await import("@/lib/twilio");
    await sendComicMms({ to: "+15551112222", body: "text only" });
    expect(h.create).toHaveBeenCalledWith({ to: "+15551112222", from: "+15550000000", body: "text only" });
  });

  it("preserves WhatsApp prefixes for both addresses", async () => {
    const { sendChannelMessage } = await import("@/lib/twilio");
    await sendChannelMessage({
      channel: "whatsapp",
      to: "+15551112222",
      body: "done",
      mediaUrl: "https://account.blob.core.windows.net/comics/x.png",
    });
    expect(h.create).toHaveBeenCalledWith({
      to: "whatsapp:+15551112222",
      from: "whatsapp:+14155238886",
      body: "done",
      mediaUrl: ["https://account.blob.core.windows.net/comics/x.png"],
    });
  });

  it("sets the per-message status callback when supplied", async () => {
    const { sendChannelMessage } = await import("@/lib/twilio");
    await sendChannelMessage({
      channel: "sms",
      to: "+15551112222",
      body: "ready",
      statusCallback: "https://comic.example/api/twilio/status?jobId=123",
    });
    expect(h.create).toHaveBeenCalledWith({
      to: "+15551112222",
      from: "+15550000000",
      body: "ready",
      statusCallback: "https://comic.example/api/twilio/status?jobId=123",
    });
  });

  it("sets a bounded Twilio queue lifetime only on SMS when requested", async () => {
    const { sendChannelMessage } = await import("@/lib/twilio");
    await sendChannelMessage({
      channel: "sms",
      to: "+15551112222",
      body: "ready",
      validityPeriod: 120,
    });
    expect(h.create).toHaveBeenCalledWith({
      to: "+15551112222",
      from: "+15550000000",
      body: "ready",
      validityPeriod: 120,
    });

    await sendChannelMessage({
      channel: "whatsapp",
      to: "+15551112222",
      body: "ready",
      validityPeriod: 120,
    });
    expect(h.create).toHaveBeenLastCalledWith({
      to: "whatsapp:+15551112222",
      from: "whatsapp:+14155238886",
      body: "ready",
    });
  });

  it("rejects an invalid SMS queue lifetime before calling Twilio", async () => {
    const { sendChannelMessage } = await import("@/lib/twilio");
    for (const validityPeriod of [0, 36001, 1.5, Number.NaN]) {
      await expect(sendChannelMessage({
        channel: "sms",
        to: "+15551112222",
        body: "ready",
        validityPeriod,
      })).rejects.toThrow("validityPeriod");
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it("uses an explicit sender without requiring a default sender environment variable", async () => {
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_WHATSAPP_NUMBER;
    const { sendChannelMessage } = await import("@/lib/twilio");
    await sendChannelMessage({
      channel: "sms",
      to: "+15551112222",
      from: "+15550000000",
      body: "ready",
    });
    await sendChannelMessage({
      channel: "whatsapp",
      to: "+15551112222",
      from: "+14155238886",
      body: "ready",
    });
    expect(h.create).toHaveBeenCalledWith({
      to: "+15551112222", from: "+15550000000", body: "ready",
    });
    expect(h.create).toHaveBeenCalledWith({
      to: "whatsapp:+15551112222", from: "whatsapp:+14155238886", body: "ready",
    });
  });
});

describe("Twilio media download", () => {
  const mediaUrl =
    "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM123/Media/ME123";

  it("recognizes only HTTPS Twilio media hosts without URL credentials or custom ports", async () => {
    const { isTwilioMediaUrl } = await import("@/lib/twilio");
    for (const host of [
      "api.twilio.com",
      "api.us1.twilio.com",
      "api.dublin.ie1.twilio.com",
      "api.sydney.au1.twilio.com",
      "mms.twiliocdn.com",
    ]) {
      expect(isTwilioMediaUrl(`https://${host}/media`)).toBe(true);
    }
    for (const url of [
      "http://api.twilio.com/media",
      "https://api.twilio.com.evil.example/media",
      "https://api.twilio.com@evil.example/media",
      "https://user:password@api.twilio.com/media",
      "https://api.twilio.com:8443/media",
      "https://api.us2.twilio.com/media",
      "https://fake.twiliocdn.com/media",
      "not a url",
    ]) {
      expect(isTwilioMediaUrl(url)).toBe(false);
    }
  });

  it("uses manual redirects and authenticates only trusted Twilio endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://mms.twiliocdn.com/secure/photo" },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await expect(downloadTwilioMedia(mediaUrl)).resolves.toEqual({
      buffer: Buffer.from([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(mediaUrl);
    expect(fetchMock.mock.calls[1][0]).toBe("https://mms.twiliocdn.com/secure/photo");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      `Basic ${Buffer.from("ACtest:tok").toString("base64")}`,
    );
    expect(fetchMock.mock.calls[1][1].redirect).toBe("manual");
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });

  it("fetches a direct signed Twilio CDN URL without API credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("photo"), {
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await expect(
      downloadTwilioMedia("https://mms.twiliocdn.com/secure/photo?token=signed"),
    ).resolves.toMatchObject({ contentType: "image/jpeg" });
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });

  it("never forwards credentials to an untrusted redirect", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/capture" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await expect(downloadTwilioMedia(mediaUrl)).rejects.toThrow(/untrusted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(mediaUrl);
  });

  it("rejects untrusted initial URLs before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await expect(
      downloadTwilioMedia("https://api.twilio.com.attacker.example/photo"),
    ).rejects.toThrow(/untrusted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers a configured API key for media authentication", async () => {
    process.env.TWILIO_API_KEY_SID = "SKtest";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("photo"), {
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await downloadTwilioMedia(mediaUrl);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      `Basic ${Buffer.from("SKtest:secret").toString("base64")}`,
    );
  });

  it("rejects a response advertised above the media limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("too large", {
      headers: { "content-length": String(11 * 1024 * 1024) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { downloadTwilioMedia } = await import("@/lib/twilio");
    await expect(downloadTwilioMedia(mediaUrl)).rejects.toThrow(/10 MiB/);
  });
});
