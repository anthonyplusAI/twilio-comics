"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { signIn, signOut } from "@/auth";
import { requireAdmin } from "@/lib/admin-access";
import { isVoicePhotoMode, setExperienceSettings } from "@/lib/photo-experience-settings";

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
