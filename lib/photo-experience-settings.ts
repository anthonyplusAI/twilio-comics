import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { experienceSettings, type VoicePhotoMode } from "@/lib/schema";

export type { VoicePhotoMode } from "@/lib/schema";

export type ExperienceSettings = {
  voicePhotoMode: VoicePhotoMode;
  cameraEnabled: boolean;
};

export function isVoicePhotoMode(value: unknown): value is VoicePhotoMode {
  return value === "sms" || value === "camera" || value === "none";
}

export async function getExperienceSettings(): Promise<ExperienceSettings> {
  const [saved] = await db
    .select({
      voicePhotoMode: experienceSettings.voicePhotoMode,
      cameraEnabled: experienceSettings.cameraEnabled,
    })
    .from(experienceSettings)
    .where(eq(experienceSettings.id, 1))
    .limit(1);

  return {
    voicePhotoMode: saved?.voicePhotoMode ?? "sms",
    cameraEnabled: saved?.cameraEnabled ?? false,
  };
}

export async function setExperienceSettings(settings: ExperienceSettings): Promise<void> {
  if (!isVoicePhotoMode(settings.voicePhotoMode)) {
    throw new Error("Invalid Voice photo mode");
  }
  if (typeof settings.cameraEnabled !== "boolean") {
    throw new Error("Invalid browser camera setting");
  }
  if (settings.voicePhotoMode === "camera" || settings.cameraEnabled) {
    throw new Error("The phone-linked browser camera flow is retired");
  }

  const updatedAt = new Date();
  await db
    .insert(experienceSettings)
    .values({
      id: 1,
      voicePhotoMode: settings.voicePhotoMode,
      cameraEnabled: settings.cameraEnabled,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: experienceSettings.id,
      set: {
        voicePhotoMode: settings.voicePhotoMode,
        cameraEnabled: settings.cameraEnabled,
        updatedAt,
      },
    });
}

export async function setVoicePhotoMode(mode: VoicePhotoMode): Promise<void> {
  if (!isVoicePhotoMode(mode)) throw new Error("Invalid Voice photo mode");
  if (mode === "camera") throw new Error("The phone-linked browser camera flow is retired");
  await setExperienceSettings({ voicePhotoMode: mode, cameraEnabled: false });
}
