"use client";

import { useFormStatus } from "react-dom";
import { ArrowRight } from "lucide-react";
import styles from "../admin.module.css";

export function GoogleSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className={styles.loginGoogleButton}
      disabled={pending}
      aria-busy={pending}
    >
      <span className={styles.loginGoogleMark} aria-hidden="true">G</span>
      <span aria-live="polite">{pending ? "Opening Google…" : "Continue with Google"}</span>
      <ArrowRight size={18} aria-hidden="true" />
    </button>
  );
}
