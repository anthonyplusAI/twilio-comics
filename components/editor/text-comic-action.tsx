"use client";

import { useState, type FormEvent } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Phase = "phone" | "code" | "sent";

async function requestComicText(path: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || result?.ok !== true) {
    throw new Error(typeof result?.error === "string" ? result.error : "Could not request a text right now");
  }
  return result;
}

export function TextComicAction({ storySlug }: { storySlug: string }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [verifiedNumber, setVerifiedNumber] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestComicText("/api/studio/text-comic/start", { storySlug, phoneNumber });
      if (typeof result.phoneNumber !== "string") throw new Error("Could not start verification right now");
      setVerifiedNumber(result.phoneNumber);
      setCode("");
      setPhase("code");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send a code right now");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestComicText("/api/studio/text-comic/confirm", { storySlug, code });
      setPhase("sent");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not text the comic right now");
    } finally {
      setBusy(false);
    }
  }

  function changeNumber() {
    setPhase("phone");
    setCode("");
    setError(null);
  }

  return (
    <>
      <button
        data-comic-text-action
        type="button"
        onClick={() => {
          if (phase === "sent") changeNumber();
          setOpen(true);
        }}
      >
        <MessageSquareText size={18} aria-hidden="true" />
        {phase === "sent" ? "Text another number" : "Text me the comic"}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-2 border-[#000d25] bg-white text-[#000d25] shadow-[8px_8px_0_#000d25]">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold">Text me the comic</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-[#38425e]">
              We’ll text a link to this comic after you confirm your phone number. Your comic is already here in the browser.
            </DialogDescription>
          </DialogHeader>

          {phase === "phone" && (
            <form onSubmit={sendCode} className="grid gap-4">
              <label htmlFor="comic-text-phone" className="grid gap-2 text-sm font-bold">
                Mobile number
                <Input
                  id="comic-text-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+1 555 123 4567"
                  value={phoneNumber}
                  onChange={(event) => {
                    setPhoneNumber(event.target.value);
                    setError(null);
                  }}
                  required
                  disabled={busy}
                  className="h-11 border-2 border-[#000d25] bg-white text-base"
                />
              </label>
              <p className="m-0 text-xs leading-relaxed text-[#38425e]">
                You’ll receive a verification code and, after confirming it, one comic link. Message and data rates may apply. Reply HELP for help or STOP to opt out.
              </p>
              <Button type="submit" disabled={busy} className="h-11 bg-[#db132a] font-bold text-white hover:bg-[#b80f23]">
                {busy ? "Sending code…" : "Send verification code"}
              </Button>
            </form>
          )}

          {phase === "code" && (
            <form onSubmit={confirmCode} className="grid gap-4">
              <p className="m-0 text-sm">Enter the six-digit code sent to <strong>{verifiedNumber}</strong>.</p>
              <label htmlFor="comic-text-code" className="grid gap-2 text-sm font-bold">
                Verification code
                <Input
                  id="comic-text-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, ""));
                    setError(null);
                  }}
                  required
                  disabled={busy}
                  className="h-11 border-2 border-[#000d25] bg-white text-base tracking-widest"
                />
              </label>
              <Button type="submit" disabled={busy || code.length !== 6} className="h-11 bg-[#db132a] font-bold text-white hover:bg-[#b80f23]">
                {busy ? "Sending comic link…" : "Confirm and text comic link"}
              </Button>
              <button type="button" onClick={changeNumber} disabled={busy} className="w-fit text-sm font-bold underline underline-offset-2 disabled:opacity-50">
                Change number or request another code
              </button>
            </form>
          )}

          {phase === "sent" && (
            <div className="grid gap-3">
              <p role="status" className="m-0 text-sm leading-relaxed">
                Twilio accepted the request to text your comic link to <strong>{verifiedNumber}</strong>. You can keep reading or sharing it here.
              </p>
              <Button type="button" onClick={() => setOpen(false)} className="h-11 bg-[#000d25] font-bold text-white hover:bg-[#243454]">
                Back to comic
              </Button>
              <button type="button" onClick={changeNumber} className="w-fit text-sm font-bold underline underline-offset-2">
                Text another number
              </button>
            </div>
          )}

          {error && <p role="alert" className="m-0 text-sm font-bold text-rose-700">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
