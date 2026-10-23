import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Camera, MessageCircle, PhoneCall } from "lucide-react";
import { updatePhotoExperienceSettings } from "@/app/admin/actions";
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

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireAdmin();
  const [{ voicePhotoMode, cameraEnabled }, params] = await Promise.all([
    getExperienceSettings(),
    searchParams,
  ]);

  return (
    <div className={styles.settingsPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Experience settings</p>
          <h1>Photo experiences.</h1>
          <p>Choose where people can add photos and how phone calls use them.</p>
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
