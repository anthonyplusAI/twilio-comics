import twilio from "twilio";

const VERIFY_SERVICE_SID = /^VA[0-9a-f]{32}$/i;

function service() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !serviceSid || !VERIFY_SERVICE_SID.test(serviceSid)) {
    throw new Error("Twilio Verify is not configured for Voice calls");
  }
  return twilio(accountSid, authToken).verify.v2.services(serviceSid);
}

export function isVoiceVerificationConfigured(): boolean {
  return VERIFY_SERVICE_SID.test(process.env.TWILIO_VERIFY_SERVICE_SID?.trim() || "");
}

/** Twilio Verify owns token generation, delivery limits, and expiry. */
export async function startVoiceVerification(to: string): Promise<void> {
  const verification = await service().verifications.create({ to, channel: "sms" });
  if (verification.status !== "pending") {
    throw new Error("Twilio Verify did not start a pending SMS verification");
  }
}

export async function checkVoiceVerification(to: string, code: string): Promise<boolean> {
  const check = await service().verificationChecks.create({ to, code });
  return check.status === "approved";
}
