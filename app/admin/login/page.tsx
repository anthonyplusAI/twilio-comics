import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LockKeyhole, ArrowRight } from "lucide-react";
import { auth } from "@/auth";
import { isAdminSession } from "@/lib/admin-auth";
import { adminGoogleSignIn, adminSignIn } from "@/app/admin/actions";
import styles from "../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Administrator sign in | Twilio Comics",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  if (isAdminSession(await auth())) redirect("/admin");
  const { error, changed } = await searchParams;
  const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

  return (
    <main className={styles.loginShell}>
      <div className={styles.loginBackground} aria-hidden="true" />
      <div className={styles.loginCard}>
        <Link className={styles.loginBrand} href="/" aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={43} height={43} />
          <span>Twilio Comics</span>
        </Link>
        <div className={styles.loginMark} aria-hidden="true"><LockKeyhole size={27} /></div>
        <h1>Operations sign in</h1>
        <p className={styles.loginIntro}>
          View retained texts, calls, comic jobs, and delivery history.
        </p>
        {error ? (
          <p className={styles.loginError} role="alert">
            Sign in failed. Check your credentials or try again later.
          </p>
        ) : changed === "1" ? (
          <p className={styles.loginSuccess} role="status">
            Admin login updated. Sign in with your new username and password.
          </p>
        ) : null}
        {googleConfigured && (
          <>
            <form action={adminGoogleSignIn} className={styles.loginGoogleForm}>
              <button type="submit" className={styles.loginGoogleButton}>
                <span className={styles.loginGoogleMark} aria-hidden="true">G</span>
                Continue with Google
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            </form>
            <p className={styles.loginGoogleHint}>
              Use a verified @twilio.com Google Workspace account.
            </p>
            <div className={styles.loginDivider} aria-hidden="true"><span>or use operator password</span></div>
          </>
        )}
        <form action={adminSignIn} className={styles.loginForm}>
          <label htmlFor="admin-username">Username</label>
          <input id="admin-username" name="username" type="text" autoComplete="username" required maxLength={128} />
          <label htmlFor="admin-password">Password</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" required />
          <button type="submit">Sign in <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
        <p className={styles.loginFooter}>
          {googleConfigured
            ? "Restricted to Twilio Workspace accounts and the operator password."
            : "Restricted to the Twilio Comics operator."}
        </p>
      </div>
    </main>
  );
}
