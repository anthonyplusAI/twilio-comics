import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { experienceSettings } from "@/lib/schema";

/** Public Browser Studio is an explicit operator choice, off by default. */
export async function getBrowserStudioEnabled(): Promise<boolean> {
  const [saved] = await db
    .select({ enabled: experienceSettings.studioEnabled })
    .from(experienceSettings)
    .where(eq(experienceSettings.id, 1))
    .limit(1);
  return saved?.enabled ?? false;
}

export async function setBrowserStudioEnabled(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new Error("Invalid Browser Studio setting");
  const updatedAt = new Date();
  await db
    .insert(experienceSettings)
    .values({ id: 1, studioEnabled: enabled, updatedAt })
    .onConflictDoUpdate({
      target: experienceSettings.id,
      set: { studioEnabled: enabled, updatedAt },
    });
}
