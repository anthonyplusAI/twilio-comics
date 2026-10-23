import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getExperienceSettings: vi.fn(),
  getPublicEnabledChannels: vi.fn(),
  isVoiceVerificationConfigured: vi.fn(),
}));

vi.mock("@/lib/photo-experience-settings", () => ({
  getExperienceSettings: h.getExperienceSettings,
}));
vi.mock("@/lib/public-channel-readiness", () => ({
  getPublicEnabledChannels: h.getPublicEnabledChannels,
}));
vi.mock("@/lib/voice-verification", () => ({
  isVoiceVerificationConfigured: h.isVoiceVerificationConfigured,
}));

import { getCameraDestination } from "@/lib/browser-photo-access";

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+18669012028");
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,voice");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("AUTH_SECRET", "test-signing-secret");
  h.getExperienceSettings.mockResolvedValue({ cameraEnabled: true, voicePhotoMode: "sms" });
  h.getPublicEnabledChannels.mockReturnValue(["sms", "voice"]);
  h.isVoiceVerificationConfigured.mockReturnValue(true);
});

describe("browser camera channel availability", () => {
  it("offers both channels when the admin enables camera intake", async () => {
    expect(await getCameraDestination()).toEqual({
      phoneNumber: "+18669012028",
      smsHref: "sms:+18669012028?body=Turn%20me%20into%20a%20comic!",
      callHref: "tel:+18669012028",
    });
    h.getExperienceSettings.mockClear();
    expect(await getCameraDestination({ cameraEnabled: true, voicePhotoMode: "sms" }))
      .toMatchObject({ callHref: "tel:+18669012028" });
    expect(h.getExperienceSettings).not.toHaveBeenCalled();
  });

  it("supports an SMS-only launch without a ready Voice channel", async () => {
    h.getPublicEnabledChannels.mockReturnValue(["sms"]);
    expect(await getCameraDestination()).toMatchObject({
      smsHref: expect.stringMatching(/^sms:/),
      callHref: null,
    });
  });

  it("supports Voice when photos are allowed but hides its action in none mode", async () => {
    h.getPublicEnabledChannels.mockReturnValueOnce(["voice"]);
    expect(await getCameraDestination()).toMatchObject({
      smsHref: null,
      callHref: "tel:+18669012028",
    });

    h.getExperienceSettings.mockResolvedValue({ cameraEnabled: true, voicePhotoMode: "none" });
    h.getPublicEnabledChannels.mockReturnValue(["voice"]);
    expect(await getCameraDestination()).toBeNull();
  });

  it("keeps SMS camera available in Voice none mode", async () => {
    h.getExperienceSettings.mockResolvedValue({ cameraEnabled: true, voicePhotoMode: "none" });
    expect(await getCameraDestination()).toMatchObject({
      smsHref: expect.stringMatching(/^sms:/),
      callHref: null,
    });
  });

  it("fails closed when camera opt-in, Verify, public origin, or selected channels are missing", async () => {
    h.getExperienceSettings.mockResolvedValueOnce({ cameraEnabled: false, voicePhotoMode: "sms" });
    expect(await getCameraDestination()).toBeNull();

    h.isVoiceVerificationConfigured.mockReturnValueOnce(false);
    expect(await getCameraDestination()).toBeNull();

    h.getPublicEnabledChannels.mockReturnValueOnce([]);
    expect(await getCameraDestination()).toBeNull();

    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(await getCameraDestination()).toBeNull();
    vi.stubEnv("PUBLIC_BASE_URL", "http://comics.example.com");
    expect(await getCameraDestination()).toBeNull();
  });
});
