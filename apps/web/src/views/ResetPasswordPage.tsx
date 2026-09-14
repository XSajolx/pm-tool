import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth.js";

/**
 * Row 79: the page the e-mailed reset link lands on. Supabase turns the link
 * into a recovery session on load; once we have one, the form sets the new
 * password. Signed-in users can use it as "change password" too.
 */
export function ResetPasswordPage() {
  const { session, loading, updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
      setTimeout(() => window.location.assign(import.meta.env.BASE_URL), 1200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbfa] px-6">
      <div className="w-full max-w-[380px] rounded-lg border border-border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Choose a new password</h1>
        {loading ? (
          <p className="mt-3 text-sm text-muted-foreground">Checking your link…</p>
        ) : !session ? (
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>This reset link is invalid or has expired.</p>
            <p>
              Go back to{" "}
              <a href={import.meta.env.BASE_URL} className="font-medium text-indigo-600 hover:underline">
                sign in
              </a>{" "}
              and choose “Forgot password?” to get a fresh one.
            </p>
          </div>
        ) : done ? (
          <p className="mt-3 text-sm text-green-700">Password updated. Taking you to your workspace…</p>
        ) : (
          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">Signed in as {session.user.email}.</p>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-slate-700">New password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-slate-700">Confirm</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20" />
            </label>
            {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-md bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
