"use server";

import { AuthError } from "next-auth";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { signIn, signOut } from "@/auth";
import { requireAdmin } from "@/lib/admin-access";
import { rotateAdminCredentials } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { isVoicePhotoMode, setExperienceSettings } from "@/lib/photo-experience-settings";
import { MAX_GENERATION_QUOTA_OVERRIDE, UNLIMITED_GENERATION_QUOTA_OVERRIDE } from "@/lib/quota";
import { users } from "@/lib/schema";

export async function adminSignIn(formData: FormData): Promise<void> {
  const username = formData.get("username");
  const password = formData.get("password");
  if (typeof username !== "string" || typeof password !== "string") {
    redirect("/admin/login?error=invalid");
  }

  try {
    await signIn("admin", { username, password, redirectTo: "/admin" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/admin/login?error=invalid");
    throw error;
  }
}

export async function adminSignOut(): Promise<void> {
  await signOut({ redirectTo: "/admin/login" });
}

export async function updatePhotoExperienceSettings(formData: FormData): Promise<void> {
  await requireAdmin();

  const mode = formData.get("voicePhotoMode");
  const cameraValues = formData.getAll("cameraEnabled");
  if (
    !isVoicePhotoMode(mode) ||
    cameraValues.length > 1 ||
    cameraValues.some((value) => value !== "on")
  ) {
    redirect("/admin/settings?error=invalid");
  }
  const cameraEnabled = cameraValues.length === 1;
  if (mode === "camera" && !cameraEnabled) {
    redirect("/admin/settings?error=camera-required");
  }

  await setExperienceSettings({ voicePhotoMode: mode, cameraEnabled });
  revalidatePath("/start");
  revalidatePath("/start/camera");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

export async function updateUserGenerationQuota(formData: FormData): Promise<void> {
  await requireAdmin();

  const userIds = formData.getAll("userId");
  const userId = userIds.length === 1 && typeof userIds[0] === "string"
    ? userIds[0] : "";
  if (!userId || userId.length > 200) redirect("/admin/users");

  const path = `/admin/users/${encodeURIComponent(userId)}`;
  const modes = formData.getAll("quotaMode");
  const customLimits = formData.getAll("customLimit");
  const mode = modes.length === 1 ? modes[0] : null;
  const customLimit = customLimits.length === 1 ? customLimits[0] : null;

  let generationQuotaLimit: number | null;
  if (mode === "default") {
    generationQuotaLimit = null;
  } else if (mode === "unlimited") {
    generationQuotaLimit = UNLIMITED_GENERATION_QUOTA_OVERRIDE;
  } else if (mode === "custom" && typeof customLimit === "string" &&
      /^\d+$/.test(customLimit) && Number(customLimit) <= MAX_GENERATION_QUOTA_OVERRIDE) {
    generationQuotaLimit = Number(customLimit);
  } else {
    redirect(`${path}?quotaError=invalid#quota-settings`);
  }

  const [updated] = await db.update(users)
    .set({ generationQuotaLimit, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!updated) redirect("/admin/users?quotaError=missing-user");

  revalidatePath(path);
  revalidatePath("/admin/users");
  redirect(`${path}?quotaSaved=1#quota-settings`);
}

export async function updateAdminCredentials(formData: FormData): Promise<void> {
  await requireAdmin();

  const currentPassword = formData.get("currentPassword");
  const newUsername = formData.get("newUsername");
  const newPassword = formData.get("newPassword");
  const confirmNewPassword = formData.get("confirmNewPassword");
  const normalizedNewUsername = typeof newUsername === "string" ? newUsername.trim() : "";

  if (
    typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 1024 ||
    !/^[A-Za-z0-9._-]{3,64}$/.test(normalizedNewUsername) ||
    typeof newPassword !== "string" || newPassword.length < 1 || newPassword.length > 1024 ||
    typeof confirmNewPassword !== "string"
  ) {
    redirect("/admin/settings?credentialError=invalid-input#change-login");
  }
  if (newPassword !== confirmNewPassword) {
    redirect("/admin/settings?credentialError=mismatch#change-login");
  }

  const result = await rotateAdminCredentials({
    currentPassword,
    newUsername: normalizedNewUsername,
    newPassword,
  });
  if (!result.ok) {
    redirect(`/admin/settings?credentialError=${result.reason}#change-login`);
  }

  await signOut({ redirectTo: "/admin/login?changed=1" });
}
