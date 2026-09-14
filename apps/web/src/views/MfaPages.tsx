import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";

/**
 * Row 81: two-factor authentication. TOTP enrolment and verification talk to
 * Supabase Auth directly (that's where the factor lives); our API records the
 * enrolment, issues backup codes and enforces the second factor on every call.
 */

/** Shared enrolment widget - used by the gate page and by Settings › Security. */
export function MfaEnroll({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // React StrictMode runs effects twice in dev; enrolling twice trips GoTrue up.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // Tidy up half-finished enrolments so Supabase doesn't refuse a duplicate name.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) if (f.factor_type === "totp" && f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `4S PM Tool ${Date.now()}` });
      if (error) return setError(/not enabled|disabled/i.test(error.message) ? "Two-factor authentication isn't switched on in Supabase yet (Authentication → Multi-factor → TOTP)." : error.message);
      setFactorId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
    })().catch((err: Error) => setError(err.message));
  }, []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error) throw new Error(error.message);
      const res = await api.mfaEnrolled();
      setCodes(res.codes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-slate-900">Two-factor authentication is on.</p>
        <p className="text-sm text-muted-foreground">Save these backup codes somewhere safe. Each works once, for when you don't have your phone.</p>
        <ul className="grid grid-cols-2 gap-1 rounded-md border border-border bg-[#fbfbfa] p-3 font-mono text-sm text-slate-800">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <button type="button" onClick={onDone} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
          I've saved them
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={verify} className="space-y-3">
      <p className="text-sm text-muted-foreground">Scan this with Google Authenticator, 1Password, Authy or any TOTP app, then enter the 6-digit code it shows.</p>
      {qr ? <img src={qr} alt="Authenticator QR code" className="h-40 w-40 rounded-md border border-border bg-white p-1" /> : !error && <p className="text-sm text-muted-foreground">Preparing…</p>}
      {secret && (
        <p className="text-[11px] text-muted-foreground">
          Can't scan? Enter this key by hand: <code className="select-all rounded bg-muted px-1 font-mono">{secret}</code>
        </p>
      )}
      <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" maxLength={8} className="w-40 rounded-md border border-border px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-indigo-500" />
      {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}
      <div>
        <button type="submit" disabled={busy || !factorId || code.trim().length < 6} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "Checking…" : "Turn on 2FA"}
        </button>
      </div>
    </form>
  );
}

/** The gate shown when the workspace requires 2FA for the user's role and they haven't set it up. */
export function MfaEnrollPage() {
  const { refreshMe, signOut } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbfa] px-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Set up two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your workspace requires it for your role. It takes a minute.</p>
        <div className="mt-4">
          <MfaEnroll onDone={() => void refreshMe()} />
        </div>
        <button type="button" onClick={() => void signOut()} className="mt-4 text-xs text-slate-500 hover:underline">
          Sign out
        </button>
      </div>
    </div>
  );
}

/** The gate shown on every sign-in for enrolled users until the second factor is presented. */
export function MfaVerifyPage() {
  const { refreshMe, signOut, user } = useAuth();
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (useBackup) {
        await api.mfaUseBackup(code.trim());
      } else {
        const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
        if (fErr) throw new Error(fErr.message);
        const factor = factors.totp.find((f) => f.status === "verified") ?? factors.totp[0];
        if (!factor) throw new Error("No authenticator is set up for this account - use a backup code.");
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
        if (error) throw new Error(error.message);
      }
      await refreshMe();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbfa] px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Two-factor check</h1>
        <p className="mt-1 text-sm text-muted-foreground">{useBackup ? "Enter one of your backup codes." : `Enter the 6-digit code from your authenticator app for ${user?.email ?? "your account"}.`}</p>
        <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" placeholder={useBackup ? "xxxxx-xxxxx" : "123 456"} className="mt-4 w-full rounded-md border border-border px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-indigo-500" />
        {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}
        <button type="submit" disabled={busy || code.trim().length < 6} className="mt-4 w-full rounded-md bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "Checking…" : "Continue"}
        </button>
        <div className="mt-4 flex items-center justify-between text-xs">
          <button type="button" onClick={() => { setUseBackup((b) => !b); setError(null); setCode(""); }} className="text-indigo-600 hover:underline">
            {useBackup ? "Use my authenticator instead" : "Use a backup code"}
          </button>
          <button type="button" onClick={() => void signOut()} className="text-slate-500 hover:underline">
            Sign out
          </button>
        </div>
      </form>
    </div>
  );
}
