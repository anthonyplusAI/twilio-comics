import {
  getEnabledChannels,
  type MarketingChannel,
  type MarketingContact,
} from "@/lib/marketing-contact";
import { getConversationRelayUrl } from "@/lib/voice-twiml";
import { isVoiceVerificationConfigured } from "@/lib/voice-verification";

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

/**
 * Public links are a release action. A selected Voice link must have the
 * verification and Relay configuration needed to answer that call.
 */
export function getPublicEnabledChannels(
  contact: MarketingContact,
  selection: string | undefined,
): MarketingChannel[] {
  const voiceReady = isVoiceVerificationConfigured() &&
    ACCOUNT_SID.test(process.env.TWILIO_ACCOUNT_SID || "") &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env.AUTH_SECRET) &&
    Boolean(getConversationRelayUrl());
  return getEnabledChannels(contact, selection)
    .filter((channel) => channel !== "voice" || voiceReady);
}
