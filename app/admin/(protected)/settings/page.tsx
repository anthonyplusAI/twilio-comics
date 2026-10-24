import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Camera, MessageCircle, PhoneCall } from "lucide-react";
import { updateAdminCredentials, updatePhotoExperienceSettings } from "@/app/admin/actions";
import { requireAdmin } from "@/lib/admin-access";
import { getExperienceSettings, type VoicePhotoMode } from "@/lib/photo-experience-settings";
import styles from "../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Experience settings | Twilio Comics",
  robots: { index: false, follow: false },
};

const voicePhotoOptions = [
  {
    value: "sms",
    title: "Use saved photos (text first)",
    description: "For calls, prefer photos texted from the same number. Use browser photos if the camera is enabled and no text photos are saved.",
    icon: MessageCircle,
  },
  {
    value: "camera",
    title: "Use saved photos (camera first)",
    description: "For calls, prefer verified browser photos, then fall back to photos sent by text. Enable the browser camera below.",
    icon: Camera,
  },
  {
    value: "none",
    title: "Calls without photos",
    description: "Voice ignores saved photos. The browser camera can still serve SMS when enabled.",
    icon: PhoneCall,
  },
] as const satisfies ReadonlyArray<{
  value: VoicePhotoMode;
  title: string;
  description: string;
  icon: typeof PhoneCall;
}>;

function credentialErrorMessage(error: string | undefined): string | null {
  switch (error) {
    case "invalid-current":
      return "The current password is incorrect. Try again.";
    case "password-reused":
      return "Choose a new password that differs from your current password.";
    case "rate-limited":
      return "Too many attempts. Wait 15 minutes, then try again.";
    case "conflict":
      return "The admin login changed in another session. Sign in again before retrying.";
    case "invalid-input":
      return "Use a 3–64 character username with letters, numbers, dots, underscores, or hyphens, and a password of 1–1,024 characters with a non-space character and no control characters.";
    case "mismatch":
      return "The new passwords do not match.";
    default:
      return null;
  }
}

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; credentialError?: string }>;
}) {
  const session = await requireAdmin();
  const [{ voicePhotoMode, cameraEnabled }, params] = await Promise.all([
    getExperienceSettings(),
    searchParams,
  ]);
  const credentialError = credentialErrorMessage(params.credentialError);

  return (
    <div className={styles.settingsPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations settings</p>
          <h1>Settings.</h1>
          <p>Manage your admin login and the photo experience.</p>
        </div>
        <Link className={styles.backAction} href="/admin">
          <ArrowLeft size={17} aria-hidden="true" /> Overview
        </Link>
      </div>

      {params.saved === "1" && (
        <p className={styles.settingsSuccess} role="status">Saved. The public start page now reflects this choice.</p>
      )}
      {params.error === "invalid" && (
        <p className={styles.settingsError} role="alert">Choose one of the available photo options.</p>
      )}
      {params.error === "camera-required" && (
        <p className={styles.settingsError} role="alert">Turn on the browser camera to make it the first photo source for calls.</p>
      )}

      <section className={`${styles.settingsPanel} ${styles.credentialsPanel}`} id="change-login" aria-labelledby="change-login-heading">
        <div className={styles.settingsPanelHeading}>
          <div>
            <h2 id="change-login-heading">Change admin login</h2>
            <p>Choose a new username and password. You will sign in again after saving.</p>
          </div>
        </div>
        <form action={updateAdminCredentials} className={styles.settingsForm}>
          {credentialError && (
            <p className={styles.settingsError} role="alert">{credentialError}</p>
          )}
          <div className={styles.credentialFields}>
            <label className={styles.credentialField} htmlFor="current-admin-password">
              <span>Current password</span>
              <input
                id="current-admin-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label className={styles.credentialField} htmlFor="new-admin-username">
              <span>New username</span>
              <input
                id="new-admin-username"
                name="newUsername"
                type="text"
                defaultValue={session.user?.name ?? ""}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="new-admin-username-hint"
                minLength={3}
                maxLength={64}
                pattern="[A-Za-z0-9._\\-]{3,64}"
                required
              />
              <small id="new-admin-username-hint">3–64 letters, numbers, dots, underscores, or hyphens.</small>
            </label>
            <label className={styles.credentialField} htmlFor="new-admin-password">
              <span>New password</span>
              <input
                id="new-admin-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                aria-describedby="new-admin-password-hint"
                minLength={1}
                maxLength={1024}
                required
              />
              <small id="new-admin-password-hint">1–1,024 characters. Include a non-space character; no control characters.</small>
            </label>
            <label className={styles.credentialField} htmlFor="confirm-admin-password">
              <span>Confirm new password</span>
              <input
                id="confirm-admin-password"
                name="confirmNewPassword"
                type="password"
                autoComplete="new-password"
                minLength={1}
                maxLength={1024}
                required
              />
            </label>
          </div>
          <div className={styles.settingsActions}>
            <button type="submit">Update login</button>
          </div>
        </form>
      </section>

      <section className={styles.settingsPanel} aria-labelledby="voice-photo-heading">
        <div className={styles.settingsPanelHeading}>
          <div>
            <h2 id="voice-photo-heading">Photo setup</h2>
            <p>Visitors can text photos in their SMS chat. These settings add a browser option and control photo use during calls.</p>
          </div>
          <Link href="/start" target="_blank" rel="noopener noreferrer">
            View start page <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>

        <form action={updatePhotoExperienceSettings} className={styles.settingsForm}>
          <fieldset>
            <legend className={styles.settingsLegend}>Browser photo booth</legend>
            <label className={styles.settingsToggleCard}>
              <input
                className={styles.settingsCheck}
                type="checkbox"
                name="cameraEnabled"
                defaultChecked={cameraEnabled}
              />
              <span className={styles.settingsChoiceIcon}><Camera size={22} aria-hidden="true" /></span>
              <span className={styles.settingsChoiceCopy}>
                <strong>Offer camera and photo upload</strong>
                <span>After phone verification, people can add up to two photos for an SMS comic or a photo-enabled call.</span>
              </span>
            </label>
          </fieldset>

          <fieldset className={styles.settingsVoiceFieldset}>
            <legend className={styles.settingsLegend}>How calls use saved photos</legend>
            <div className={styles.settingsChoices}>
              {voicePhotoOptions.map(({ value, title, description, icon: Icon }) => (
                <label className={styles.settingsChoice} key={value}>
                  <input
                    className={styles.settingsRadio}
                    type="radio"
                    name="voicePhotoMode"
                    value={value}
                    defaultChecked={voicePhotoMode === value}
                    required
                  />
                  <span className={styles.settingsChoiceIcon}><Icon size={22} aria-hidden="true" /></span>
                  <span className={styles.settingsChoiceCopy}>
                    <strong>{title}</strong>
                    <span>{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={styles.settingsActions}>
            <button type="submit">Save settings</button>
            <p>Saved in PostgreSQL and kept through app deployments.</p>
          </div>
        </form>
      </section>
    </div>
  );
}
