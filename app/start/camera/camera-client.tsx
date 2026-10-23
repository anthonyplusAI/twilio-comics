"use client";

import Image from "next/image";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowUpRight, Camera, Check, ImagePlus, MessageCircle, Phone } from "lucide-react";
import styles from "./camera.module.css";

type CameraStatus = {
  available?: boolean;
  verified?: boolean;
  phoneNumber?: string;
  photoCount?: number;
  error?: string;
};

const CLEAR_SESSION_URL = "/api/voice/photos/session/clear";
const KIOSK_IDLE_MS = 5 * 60 * 1000;
type CameraStep = "loading" | "blocked" | "number" | "code" | "photos" | "finished";

export function cameraStepAfterClear(finished: boolean, cleared: boolean): CameraStep {
  if (!cleared) return "blocked";
  return finished ? "finished" : "number";
}

export function cameraActionsAvailable(step: CameraStep): boolean {
  return step === "finished";
}

async function jsonResponse(response: Response): Promise<CameraStatus> {
  const data: unknown = await response.json().catch(() => ({}));
  return data && typeof data === "object" ? data as CameraStatus : {};
}

export function CameraFinishPrompt({
  photoCount,
  busySlot,
  onFinish,
}: {
  photoCount: number;
  busySlot: number | null;
  onFinish: () => void;
}) {
  return (
    <div className={styles.finishSetup}>
      <div>
        <strong>{photoCount === 0 ? "No photo? You can still start." : "Ready to continue?"}</strong>
        <p>
          {photoCount === 0
            ? "You can continue without photos. Finish closes your verified session on this screen."
            : "Tap Finish before you leave. Your saved photos stay ready for your phone for 24 hours."}
        </p>
      </div>
      <button type="button" disabled={busySlot !== null} onClick={onFinish}>
        Finish photo setup
      </button>
    </div>
  );
}

export function CameraHandoffPanel({
  smsHref,
  callHref,
  contactNumber,
}: {
  smsHref: string | null;
  callHref: string | null;
  contactNumber: string;
}) {
  return (
    <section className={styles.finishPanel} aria-labelledby="finish-title">
      <div>
        <span className={styles.stepLabel}>Step 3</span>
        <h2 id="finish-title">Ready to tell your story?</h2>
        <strong className={styles.targetNumber}>{contactNumber}</strong>
        <p>
          Photo setup is finished on this screen. Use your own phone. {" "}
          {smsHref && callHref
            ? "Tap Send in your text app or call. Your comic link comes back by text."
            : smsHref
              ? "Tap Send in your text app. Your comic link comes back by text."
              : "Call the agent. Your comic link comes back by text."}
        </p>
      </div>
      <div className={styles.finishTools}>
        <div className={styles.finishQrs} aria-label="Scan with your phone to continue">
          {smsHref && (
            <div className={styles.finishQr}>
              <QRCodeSVG value={smsHref} size={100} level="M" aria-label="Scan to open SMS draft" />
              <span>Scan to text</span>
            </div>
          )}
          {callHref && (
            <div className={styles.finishQr}>
              <QRCodeSVG value={callHref} size={100} level="M" aria-label="Scan to call" />
              <span>Scan to call</span>
            </div>
          )}
        </div>
        <div className={styles.finishActions}>
          {smsHref && (
            <a href={smsHref} className={styles.finishButton}>
              <MessageCircle size={21} aria-hidden="true" /> Open SMS draft
              <ArrowUpRight size={20} aria-hidden="true" />
            </a>
          )}
          {callHref && (
            <a href={callHref} className={styles.finishButton}>
              <Phone size={21} aria-hidden="true" /> Call the agent
              <ArrowUpRight size={20} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

export default function CameraClient({
  smsHref,
  callHref,
  contactNumber,
}: {
  smsHref: string | null;
  callHref: string | null;
  contactNumber: string;
}) {
  const [step, setStep] = useState<CameraStep>("loading");
  const [phoneInput, setPhoneInput] = useState("");
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [code, setCode] = useState("");
  const [photoCount, setPhotoCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previews, setPreviews] = useState<(string | null)[]>([null, null]);
  const previewsRef = useRef<(string | null)[]>([null, null]);
  const sessionVersionRef = useRef(0);
  const pendingRequestRef = useRef<AbortController | null>(null);
  const actionLabel = smsHref && callHref ? "Text or call" : smsHref ? "Text" : "Call";
  const actionVerb = smsHref && callHref ? "text or call" : smsHref ? "text" : "call";

  const resetSession = useCallback(async (finished = false, hadPhotos = false) => {
    const version = ++sessionVersionRef.current;
    pendingRequestRef.current?.abort();
    pendingRequestRef.current = null;
    for (const url of previewsRef.current) if (url) URL.revokeObjectURL(url);
    previewsRef.current = [null, null];
    setPreviews([null, null]);
    setPhoneInput("");
    setVerifiedPhone("");
    setCode("");
    setPhotoCount(0);
    setBusy(false);
    setBusySlot(null);
    setNotice("");
    setError("");
    setStep("loading");
    try {
      const response = await fetch(CLEAR_SESSION_URL, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        keepalive: true,
      });
      if (!response.ok) throw new Error("Could not clear the previous photo session");
      if (version === sessionVersionRef.current) {
        setStep(cameraStepAfterClear(finished, true));
        if (finished) {
          setNotice(hadPhotos
            ? "Photo setup finished. Your saved photos remain ready for your phone. Scan or tap below to start."
            : "Photo setup finished. Continue without photos by scanning or tapping below.");
        }
      }
    } catch {
      if (version === sessionVersionRef.current) {
        setError("Could not prepare a new photo session. Check your connection and retry.");
        setStep(cameraStepAfterClear(finished, false));
      }
    }
  }, []);

  // A booth visit always starts with cleared cookies; never reopen the previous
  // attendee's verified number or photos after a refresh or navigation.
  useEffect(() => { void resetSession(); }, [resetSession]);

  useEffect(() => {
    if (step !== "code" && step !== "photos") return;
    let timeout: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => { void resetSession(); }, KIOSK_IDLE_MS);
    };
    arm();
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [step, resetSession]);

  useEffect(() => () => {
    pendingRequestRef.current?.abort();
    for (const url of previewsRef.current) if (url) URL.revokeObjectURL(url);
  }, []);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const version = sessionVersionRef.current;
    const controller = new AbortController();
    pendingRequestRef.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/voice/photos/verify/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phoneInput }),
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = await jsonResponse(response);
      if (version !== sessionVersionRef.current) return;
      if (!response.ok) throw new Error(data.error || "Could not send a code");
      setVerifiedPhone(data.phoneNumber || phoneInput);
      setCode("");
      setStep("code");
      setNotice("We texted a six-digit code to your phone.");
    } catch (caught) {
      if (version === sessionVersionRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not send a code");
      }
    } finally {
      if (pendingRequestRef.current === controller) pendingRequestRef.current = null;
      if (version === sessionVersionRef.current) setBusy(false);
    }
  }

  async function checkCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const version = sessionVersionRef.current;
    const controller = new AbortController();
    pendingRequestRef.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/voice/photos/verify/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = await jsonResponse(response);
      if (version !== sessionVersionRef.current) return;
      if (!response.ok) throw new Error(data.error || "Could not verify that code");
      setVerifiedPhone(data.phoneNumber || verifiedPhone);
      setStep("photos");
      setNotice("Number verified. Add up to two photos, or continue without one.");
    } catch (caught) {
      if (version === sessionVersionRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not verify that code");
      }
    } finally {
      if (pendingRequestRef.current === controller) pendingRequestRef.current = null;
      if (version === sessionVersionRef.current) setBusy(false);
    }
  }

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>, slot: number) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busySlot !== null) return;
    const version = sessionVersionRef.current;
    const controller = new AbortController();
    pendingRequestRef.current = controller;
    setBusySlot(slot);
    setError("");
    setNotice("");
    const form = new FormData();
    form.set("file", file);
    form.set("slot", String(slot));
    try {
      const response = await fetch("/api/voice/photos/upload", {
        method: "POST",
        body: form,
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = await jsonResponse(response);
      if (version !== sessionVersionRef.current) return;
      if (!response.ok) throw new Error(data.error || "Could not save that photo");
      setPhotoCount(Math.min(2, data.photoCount ?? slot + 1));
      const oldPreview = previewsRef.current[slot];
      if (oldPreview) URL.revokeObjectURL(oldPreview);
      const next = [...previewsRef.current];
      next[slot] = URL.createObjectURL(file);
      previewsRef.current = next;
      setPreviews(next);
      setNotice(`Photo ${slot + 1} added. ${actionLabel} from ${verifiedPhone} within 24 hours.`);
    } catch (caught) {
      if (version === sessionVersionRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not save that photo");
      }
    } finally {
      if (pendingRequestRef.current === controller) pendingRequestRef.current = null;
      if (version === sessionVersionRef.current) setBusySlot(null);
    }
  }

  return (
    <div className={styles.flow}>
      <div className={styles.progress} aria-label="Photo setup progress">
        <span className={step === "photos" || step === "finished"
          ? styles.complete
          : step === "number" || step === "code" ? styles.current : ""}>
          {step === "photos" || step === "finished" ? <Check size={16} aria-hidden="true" /> : "1"} Verify number
        </span>
        <span className={step === "photos" ? styles.current : step === "finished" ? styles.complete : ""}>2 Add photos</span>
        <span className={step === "finished" ? styles.current : ""}>3 {actionLabel}</span>
        {(step === "code" || step === "photos" || step === "finished") && (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => { void resetSession(); }}
          >
            {step === "finished" ? "Set up photos for another person" : "Next person / use another number"}
          </button>
        )}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {step === "loading" && <p className={styles.loading}>Clearing this screen&apos;s photo session…</p>}

      {step === "blocked" && (
        <button className={styles.retryButton} type="button" onClick={() => { void resetSession(); }}>
          Retry photo setup
        </button>
      )}

      {step === "number" && (
        <section className={styles.panel} aria-labelledby="number-title">
          <span className={styles.stepLabel}>Step 1</span>
          <h2 id="number-title">Verify the phone you&apos;ll use.</h2>
          <form onSubmit={sendCode} className={styles.form}>
            <label htmlFor="camera-phone">Mobile number</label>
            <input
              id="camera-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phoneInput}
              onChange={(event) => setPhoneInput(event.target.value)}
              placeholder="+1 (415) 555-0123"
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? "Sending code…" : "Text me a code"}
              <ArrowUpRight size={20} aria-hidden="true" />
            </button>
          </form>
          <p className={styles.smallCopy}>We&apos;ll send one verification text. Message and data rates may apply.</p>
        </section>
      )}

      {step === "code" && (
        <section className={styles.panel} aria-labelledby="code-title">
          <span className={styles.stepLabel}>Step 1</span>
          <h2 id="code-title">Enter the code.</h2>
          <p>Sent to <strong>{verifiedPhone}</strong>.</p>
          <form onSubmit={checkCode} className={styles.form}>
            <label htmlFor="camera-code">Six-digit code</label>
            <input
              id="camera-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              required
            />
            <button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify number"}
              <ArrowUpRight size={20} aria-hidden="true" />
            </button>
          </form>
          <button className={styles.textButton} type="button" onClick={() => { void resetSession(); }}>
            Use a different number
          </button>
        </section>
      )}

      {step === "photos" && (
        <section className={styles.panel} aria-labelledby="photos-title">
          <span className={styles.stepLabel}>Step 2</span>
          <h2 id="photos-title">Add your photos.</h2>
          <p>
            {photoCount === 0
              ? "Take a selfie or choose a photo. Add a second person if you like."
              : `${photoCount} of 2 photos added for ${verifiedPhone}.`}
          </p>
          <div className={styles.photoGrid}>
            {[0, 1].map((slot) => (
              <div className={styles.photoSlot} key={slot}>
                <div className={styles.photoPreview}>
                  {previews[slot] ? (
                    <Image
                      src={previews[slot]}
                      alt={`Photo ${slot + 1} selected on this device`}
                      width={200}
                      height={160}
                      unoptimized
                    />
                  ) : slot < photoCount ? (
                    <Check size={30} aria-hidden="true" />
                  ) : (
                    <ImagePlus size={30} aria-hidden="true" />
                  )}
                </div>
                <strong>Photo {slot + 1}</strong>
                <span>{slot < photoCount ? "Added" : slot === 0 ? "Start here" : "Optional"}</span>
                <div className={styles.photoInputs}>
                  <label>
                    <Camera size={16} aria-hidden="true" /> Take photo
                    <input
                      type="file"
                      accept="image/*"
                      capture="user"
                      disabled={busySlot !== null || slot > photoCount}
                      onChange={(event) => { void uploadPhoto(event, slot); }}
                    />
                  </label>
                  <label>
                    <ImagePlus size={16} aria-hidden="true" /> Choose photo
                    <input
                      type="file"
                      accept="image/*"
                      disabled={busySlot !== null || slot > photoCount}
                      onChange={(event) => { void uploadPhoto(event, slot); }}
                    />
                  </label>
                </div>
                {busySlot === slot && <small>Saving photo…</small>}
              </div>
            ))}
          </div>
          <p className={styles.smallCopy}>
            {photoCount === 0
              ? <>For a comic without photos, finish setup and {actionVerb} from <strong>{verifiedPhone}</strong>. Give the agent your idea on your phone.</>
              : <>To use these photos, {actionVerb} from <strong>{verifiedPhone}</strong> within 24 hours. Give the agent your idea on your phone.</>}
          </p>
          <CameraFinishPrompt
            photoCount={photoCount}
            busySlot={busySlot}
            onFinish={() => { void resetSession(true, photoCount > 0); }}
          />
        </section>
      )}

      {cameraActionsAvailable(step) && (
        <CameraHandoffPanel smsHref={smsHref} callHref={callHref} contactNumber={contactNumber} />
      )}
    </div>
  );
}
