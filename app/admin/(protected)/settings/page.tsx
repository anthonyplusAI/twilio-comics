import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, BookOpen, PhoneCall } from "lucide-react";
import { updateAdminCredentials, updateBrowserStudioSetting, updateSmsVoiceSetting } from "@/app/admin/actions";
import { requireAdmin } from "@/lib/admin-access";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { isStudioStartReady } from "@/lib/studio-start-readiness";
import styles from "../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Experience settings | Twilio Comics",
  robots: { index: false, follow: false },
};

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
  await requireAdmin();
  const [studioEnabled, phoneSettings, params] = await Promise.all([
    getBrowserStudioEnabled(),
    getExperienceSettings(),
    searchParams,
  ]);
  const credentialError = credentialErrorMessage(params.credentialError);
  const studioReady = isStudioStartReady();

  return (
    <div className={styles.settingsPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations settings</p>
          <h1>Settings.</h1>
          <p>Manage your admin login and the ways people can play.</p>
        </div>
        <Link className={styles.backAction} href="/admin">
          <ArrowLeft size={17} aria-hidden="true" /> Overview
        </Link>
      </div>

      {params.saved === "studio" && (
        <p className={styles.settingsSuccess} role="status">
          Saved. Browser Studio is {studioEnabled
            ? studioReady ? "available for players" : "enabled, but unavailable until its runtime configuration is complete"
            : "closed for players"}.
        </p>
      )}
      {studioEnabled && !studioReady && (
        <p className={styles.settingsError} role="alert">
          Browser Studio is enabled but hidden from players because its server configuration is incomplete.
        </p>
      )}
      {params.saved === "voice" && (
        <p className={styles.settingsSuccess} role="status">Saved. SMS + Voice is {phoneSettings.voicePhotoMode === "none" ? "closed" : "available"} when the phone channels are configured.</p>
      )}
      {params.error === "invalid-studio" && (
        <p className={styles.settingsError} role="alert">The Browser Studio setting was invalid. Please try again.</p>
      )}
      {params.error === "invalid-voice" && (
        <p className={styles.settingsError} role="alert">The SMS + Voice setting was invalid. Please try again.</p>
      )}

      <section className={`${styles.settingsPanel} ${styles.credentialsPanel}`} id="change-login" aria-labelledby="change-login-heading">
        <div className={styles.settingsPanelHeading}>
          <div>
            <h2 id="change-login-heading">Change admin login</h2>
            <p>Update the shared operator username and password. Enter the current password even if you signed in with Google. You will sign in again after saving.</p>
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

      <section className={styles.settingsPanel} aria-labelledby="studio-setting-heading">
        <div className={styles.settingsPanelHeading}>
          <div>
            <h2 id="studio-setting-heading">Browser Studio</h2>
            <p>Open or close the browser option on the public start page.</p>
          </div>
          <Link href="/start" target="_blank" rel="noopener noreferrer">
            View start page <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>

        <form action={updateBrowserStudioSetting} className={styles.settingsForm}>
          <fieldset>
            <legend className={styles.settingsLegend}>Browser mode</legend>
            <label className={styles.settingsToggleCard}>
              <input
                className={styles.settingsCheck}
                type="checkbox"
                name="studioEnabled"
                defaultChecked={studioEnabled}
              />
              <span className={styles.settingsChoiceIcon}><BookOpen size={22} aria-hidden="true" /></span>
              <span className={styles.settingsChoiceCopy}>
                <strong>Let players make comics in their browser</strong>
                <span>Players take or upload one or two photos, choose a style, and make a comic without Google or a phone number. When SMS and Verify are configured, they can optionally text the finished link to themselves.</span>
              </span>
            </label>
          </fieldset>
          <div className={styles.settingsActions}>
            <button type="submit">Save browser setting</button>
            <p>When closed, Studio disappears from /start and creation and editing pause. Existing comics remain readable by link. Public generation uses the existing server OpenAI key. There is no weekly player quota, but rolling hourly and daily limits protect it; set a project spending limit before opening Studio.</p>
          </div>
        </form>
      </section>

      <section className={styles.settingsPanel} aria-labelledby="phone-flow-heading">
        <div className={styles.settingsPanelHeading}>
          <div>
            <h2 id="phone-flow-heading">SMS + Voice</h2>
            <p>For SMS, players text one or two photos and then their idea. For SMS + Voice, they text their photos before calling from the same number. Their finished link arrives by text.</p>
          </div>
        </div>
        <form action={updateSmsVoiceSetting} className={styles.settingsForm}>
          <fieldset>
            <legend className={styles.settingsLegend}>Call option</legend>
            <label className={styles.settingsToggleCard}>
              <input
                className={styles.settingsCheck}
                type="checkbox"
                name="voiceEnabled"
                defaultChecked={phoneSettings.voicePhotoMode !== "none"}
              />
              <span className={styles.settingsChoiceIcon}><PhoneCall size={22} aria-hidden="true" /></span>
              <span className={styles.settingsChoiceCopy}>
                <strong>Offer SMS + Voice</strong>
                <span>Players text reference photos, wait for “Photo saved,” then call from the same number. Voice must also be configured in Twilio.</span>
              </span>
            </label>
          </fieldset>
          <div className={styles.settingsActions}>
            <button type="submit">Save call setting</button>
          </div>
        </form>
      </section>
    </div>
  );
}
