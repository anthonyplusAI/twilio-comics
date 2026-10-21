import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelIdentities, users, type ChannelIdentity } from "@/lib/schema";

export type MessagingChannel = "sms" | "whatsapp" | "voice";

export function normalizeTwilioAddress(address: string): string {
  const normalized = address.replace(/^whatsapp:/i, "").trim();
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new Error("Invalid Twilio address");
  }
  return normalized;
}

export function channelFromAddress(address: string): "sms" | "whatsapp" {
  return address.toLowerCase().startsWith("whatsapp:") ? "whatsapp" : "sms";
}

function channelUserId(normalizedAddress: string): string {
  const hash = createHash("sha256").update(normalizedAddress).digest("hex");
  return `twilio_${hash.slice(0, 32)}`;
}

export async function getOrCreateChannelIdentity(
  channel: MessagingChannel,
  address: string,
): Promise<ChannelIdentity> {
  const normalizedAddress = normalizeTwilioAddress(address);
  const userId = channelUserId(normalizedAddress);

  await db
    .insert(users)
    .values({ id: userId, kind: "channel" })
    .onConflictDoNothing({ target: users.id });

  const [identity] = await db
    .insert(channelIdentities)
    .values({
      userId,
      channel,
      address,
      normalizedAddress,
    })
    .onConflictDoUpdate({
      target: [
        channelIdentities.provider,
        channelIdentities.channel,
        channelIdentities.normalizedAddress,
      ],
      set: { address, lastSeenAt: new Date(), updatedAt: new Date() },
    })
    .returning();

  if (identity) return identity;

  const [existing] = await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.provider, "twilio"),
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.normalizedAddress, normalizedAddress),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Failed to resolve channel identity");
  return existing;
}
