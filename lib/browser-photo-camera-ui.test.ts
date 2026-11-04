import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import CameraClient, {
  CameraPhotoControls,
  CameraFinishPrompt,
  CameraHandoffPanel,
  cameraActionsAvailable,
  cameraStepAfterClear,
} from "@/app/start/camera/camera-client";
import {
  captureCameraFrame,
  captureCameraFrameIfCurrent,
  openCameraStream,
  stopCameraStream,
} from "@/components/camera/camera-capture";

const PHONE = "+18669012028";
const SMS = `sms:${PHONE}?body=Turn%20me%20into%20a%20comic!`;
const CALL = `tel:${PHONE}`;

describe("shared camera booth handoff", () => {
  it("does not expose QR codes or tap actions before the session is cleared", () => {
    const html = renderToStaticMarkup(createElement(CameraClient, {
      smsHref: SMS,
      callHref: CALL,
      contactNumber: PHONE,
    }));

    expect(html).not.toContain("Scan to text");
    expect(html).not.toContain("Scan to call");
    expect(html).not.toContain(`href="${SMS}"`);
    expect(html).not.toContain(`href="${CALL}"`);
  });

  it("releases handoff actions only after a successful Finish request", () => {
    for (const step of ["loading", "blocked", "number", "code", "photos"] as const) {
      expect(cameraActionsAvailable(step)).toBe(false);
    }
    expect(cameraActionsAvailable(cameraStepAfterClear(true, false, true))).toBe(false);
    expect(cameraActionsAvailable(cameraStepAfterClear(false, true, true))).toBe(false);
    expect(cameraActionsAvailable(cameraStepAfterClear(true, true, false))).toBe(false);
    expect(cameraActionsAvailable(cameraStepAfterClear(true, true, true))).toBe(true);
  });

  it("requires a saved photo before the user can finish setup", () => {
    const html = renderToStaticMarkup(createElement(CameraFinishPrompt, {
      photoCount: 0,
      busySlot: null,
      onFinish: () => {},
    }));

    expect(html).toContain("Finish photo setup");
    expect(html).toMatch(/at least one.*photo.*required/i);
    expect(html).toContain("disabled");

    const withPhoto = renderToStaticMarkup(createElement(CameraFinishPrompt, {
      photoCount: 1,
      busySlot: null,
      onFinish: () => {},
    }));
    expect(withPhoto).not.toContain("disabled");
  });

  it("shows the phone number, tap actions, and separate text/call QR codes after Finish", () => {
    const html = renderToStaticMarkup(createElement(CameraHandoffPanel, {
      smsHref: SMS,
      callHref: CALL,
      contactNumber: PHONE,
    }));

    expect(html).toContain(PHONE);
    expect(html).toContain("Use your own phone");
    expect(html).toContain("Scan to text");
    expect(html).toContain("Scan to call");
    expect(html).toContain(`href="${SMS}"`);
    expect(html).toContain(`href="${CALL}"`);
    expect(html).toContain("Tap Send in your text app");
  });

  it("does not show a Voice action in an SMS-only setup", () => {
    const html = renderToStaticMarkup(createElement(CameraHandoffPanel, {
      smsHref: SMS,
      callHref: null,
      contactNumber: PHONE,
    }));

    expect(html).toContain("Scan to text");
    expect(html).not.toContain("Scan to call");
    expect(html).not.toContain(`href="${CALL}"`);
  });
});

describe("in-page camera capture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a camera button and keeps the file picker only for Choose photo", () => {
    const html = renderToStaticMarkup(createElement(CameraPhotoControls, {
      slot: 0,
      disabled: false,
      onTakePhoto: () => {},
      onChoosePhoto: () => {},
    }));

    expect(html).toMatch(/<button[^>]*>.*Take photo.*<\/button>/s);
    expect(html.match(/type="file"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Choose photo 1"');
    expect(html).not.toContain("capture=");
  });

  it("requests the front camera instead of opening a file picker", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    await expect(openCameraStream({ getUserMedia } as unknown as MediaDevices)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: false,
      video: { facingMode: "user" },
    });
  });

  it("explains unavailable and denied camera access", async () => {
    await expect(openCameraStream(undefined)).rejects.toThrow(/camera.*unavailable/i);
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error("blocked"), {
      name: "NotAllowedError",
    }));
    await expect(openCameraStream({ getUserMedia } as unknown as MediaDevices))
      .rejects.toThrow(/allow camera access/i);
  });

  it("captures a bounded JPEG from the live preview", async () => {
    const jpeg = new Blob(["camera frame"], { type: "image/jpeg" });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ drawImage }),
      toBlob: vi.fn((callback: BlobCallback) => callback(jpeg)),
    };
    vi.stubGlobal("document", { createElement: vi.fn().mockReturnValue(canvas) });

    const file = await captureCameraFrame({ videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement, "camera-photo-1.jpg");

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(900);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toBe("camera-photo-1.jpg");
    expect(file.size).toBe(jpeg.size);
  });

  it("stops every camera track when the preview closes", () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    stopCameraStream({ getTracks: () => [first, second] } as unknown as MediaStream);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("ignores a photo whose encoding finishes after camera cancellation", async () => {
    let finishEncoding!: (file: File) => void;
    const encoding = new Promise<File>((resolve) => { finishEncoding = resolve; });
    let current = true;
    const pending = captureCameraFrameIfCurrent(() => encoding, () => current);

    current = false;
    finishEncoding(new File(["old frame"], "old.jpg", { type: "image/jpeg" }));

    await expect(pending).resolves.toBeNull();
  });

  it("ignores a capture error after cancellation but reports a current error", async () => {
    let failEncoding!: (error: Error) => void;
    const encoding = new Promise<File>((_, reject) => { failEncoding = reject; });
    let current = true;
    const canceled = captureCameraFrameIfCurrent(() => encoding, () => current);

    current = false;
    failEncoding(new Error("Encoding failed"));
    await expect(canceled).resolves.toBeNull();

    await expect(captureCameraFrameIfCurrent(
      () => Promise.reject(new Error("Encoding failed")),
      () => true,
    )).rejects.toThrow("Encoding failed");
  });
});
