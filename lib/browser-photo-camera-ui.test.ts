import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CameraClient, {
  CameraFinishPrompt,
  CameraHandoffPanel,
  cameraActionsAvailable,
  cameraStepAfterClear,
} from "@/app/start/camera/camera-client";

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
    expect(cameraActionsAvailable(cameraStepAfterClear(true, false))).toBe(false);
    expect(cameraActionsAvailable(cameraStepAfterClear(false, true))).toBe(false);
    expect(cameraActionsAvailable(cameraStepAfterClear(true, true))).toBe(true);
  });

  it("offers Finish photo setup with zero photos and no active upload", () => {
    const html = renderToStaticMarkup(createElement(CameraFinishPrompt, {
      photoCount: 0,
      busySlot: null,
      onFinish: () => {},
    }));

    expect(html).toContain("Finish photo setup");
    expect(html).toContain("continue without photos");
    expect(html).not.toContain("disabled");
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
