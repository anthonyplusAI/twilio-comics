"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Camera, X } from "lucide-react";
import styles from "./camera-capture.module.css";

export async function openCameraStream(mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) {
    throw new Error("Camera is unavailable in this browser. Use Choose photo or open this page over HTTPS.");
  }
  try {
    return await mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
  } catch (caught) {
    const name = caught instanceof Error ? caught.name : "";
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) {
      throw new Error("Allow camera access for this site, then try again. You can also choose a photo.");
    }
    if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(name)) {
      throw new Error("No camera was found on this device. Use Choose photo instead.");
    }
    throw new Error("Could not start the camera. Check that another app is not using it, then try again.");
  }
}

export function stopCameraStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function captureCameraFrame(video: HTMLVideoElement, fileName = "camera-photo.jpg"): Promise<File> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("The camera is still starting. Wait for the preview, then try again.");
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not capture the camera image. Choose a photo instead.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((image) => {
      if (image) resolve(image);
      else reject(new Error("This browser could not capture the camera image. Try again."));
    }, "image/jpeg", 0.9);
  });
  return new File([blob], fileName, { type: "image/jpeg" });
}

export async function captureCameraFrameIfCurrent(
  captureFrame: () => Promise<File>,
  isCurrent: () => boolean,
): Promise<File | null> {
  try {
    const file = await captureFrame();
    return isCurrent() ? file : null;
  } catch (caught) {
    if (!isCurrent()) return null;
    throw caught;
  }
}

export function CameraCaptureButton({
  onCapture,
  disabled = false,
  title = "Take a reference photo",
  fileName = "camera-photo.jpg",
  className,
  children,
}: {
  onCapture: (file: File) => void;
  disabled?: boolean;
  title?: string;
  fileName?: string;
  className?: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);

  const closeCamera = useCallback(() => {
    requestIdRef.current += 1;
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setOpen(false);
    setLoading(false);
    setReady(false);
    setCapturing(false);
    setError("");
    triggerRef.current?.focus();
  }, []);

  const startCamera = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setReady(false);
    setLoading(true);
    setError("");
    try {
      const opened = await openCameraStream(navigator.mediaDevices);
      if (requestId !== requestIdRef.current) {
        stopCameraStream(opened);
        return;
      }
      streamRef.current = opened;
      setStream(opened);
    } catch (caught) {
      if (requestId === requestIdRef.current) {
        setError(caught instanceof Error ? caught.message : "Could not start the camera.");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => () => {
    requestIdRef.current += 1;
    stopCameraStream(streamRef.current);
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeCamera();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open, closeCamera]);

  useEffect(() => {
    const video = videoRef.current;
    if (!open || !stream || !video) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      if (streamRef.current !== stream) return;
      stopCameraStream(stream);
      streamRef.current = null;
      setStream(null);
      setReady(false);
      setError("Could not show the camera preview. Try again or choose a photo.");
    });
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [open, stream]);

  async function takePhoto() {
    if (!ready || capturing || !videoRef.current) return;
    const video = videoRef.current;
    const requestId = requestIdRef.current;
    setCapturing(true);
    setError("");
    let file: File | null;
    try {
      file = await captureCameraFrameIfCurrent(
        () => captureCameraFrame(video, fileName),
        () => requestId === requestIdRef.current,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not capture a photo.");
      setCapturing(false);
      return;
    }
    if (!file) return;
    closeCamera();
    onCapture(file);
  }

  function keepFocusInside(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    if (!buttons?.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ?? styles.trigger}
        aria-label={title}
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          void startCamera();
        }}
      >
        {children ?? <><Camera size={16} aria-hidden="true" /> Take photo</>}
      </button>
      {open && (
        <div className={styles.backdrop}>
          <section
            ref={panelRef}
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            onKeyDown={keepFocusInside}
          >
            <div className={styles.heading}>
              <div>
                <span className={styles.kicker}>Camera</span>
                <h2 id={headingId}>{title}</h2>
              </div>
              <button ref={cancelRef} type="button" className={styles.close} onClick={closeCamera} aria-label="Close camera">
                <X size={22} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.preview}>
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                aria-label="Live camera preview"
                onLoadedMetadata={(event) => {
                  setReady(event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0);
                }}
              />
              {!ready && <p>{loading ? "Requesting camera access…" : error ? "Camera preview unavailable" : "Starting camera preview…"}</p>}
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.shutter} disabled={!ready || capturing} onClick={() => { void takePhoto(); }}>
                <Camera size={19} aria-hidden="true" /> {capturing ? "Capturing…" : "Capture photo"}
              </button>
              {error && <button type="button" className={styles.secondary} onClick={() => { void startCamera(); }}>Try camera again</button>}
              <button type="button" className={styles.secondary} onClick={closeCamera}>Cancel</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
