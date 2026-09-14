import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import { useAuth } from "../lib/auth.js";
import { supabaseConfigured } from "../lib/supabase.js";

type Mode = "signin" | "signup" | "forgot";

const FEATURES = [
  "List, Board and Table views",
  "Real-time team chat",
  "Roles and permissions per workspace",
];

/**
 * Sign-in / sign-up. The password never touches our API — it goes straight to
 * Supabase, which hands back a session; our API only ever sees the resulting
 * token. Both modes share one panel so switching keeps whatever was typed.
 */
export function AuthPage() {
  const { signIn, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!supabaseConfigured) return <SetupNotice />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email.trim(), password);
      } else if (mode === "forgot") {
        // Row 79: self-service reset - the link lands on /reset-password.
        await resetPassword(email.trim());
        setNotice("If that address has an account, a reset link is on its way. It expires in an hour.");
        setMode("signin");
      } else {
        const { needsEmailConfirm } = await signUp(name.trim(), email.trim(), password);
        if (needsEmailConfirm) {
          setNotice(
            "Check your inbox to confirm your email, then sign in. You can turn this off in Supabase under Authentication → Providers → Confirm email.",
          );
          setMode("signin");
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full">
      {/* Brand panel */}
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-slate-900 p-10 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(60% 50% at 20% 15%, rgba(99,102,241,.55) 0%, transparent 60%), radial-gradient(50% 45% at 85% 80%, rgba(56,189,248,.35) 0%, transparent 60%)",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold">
            4S
          </span>
          <span className="text-sm font-semibold tracking-wide">4S Digital</span>
        </div>

        <div className="relative">
          <h1 className="max-w-sm text-3xl font-semibold leading-tight">
            Everything the team is working on, in one place.
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-300">
            Tasks, boards and conversations for every project — without the
            per-seat bill.
          </p>
          <ul className="mt-8 space-y-2.5 text-sm text-slate-300">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-2.5">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500/20 text-[10px] text-indigo-300">
                  ✓
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-slate-500">
          © {new Date().getFullYear()} 4S Digital
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-7">
            <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">
              {mode === "signin" ? "Welcome back" : mode === "forgot" ? "Reset your password" : "Create your account"}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {mode === "signin"
                ? "Sign in to continue to your workspace."
                : mode === "forgot"
                  ? "Enter your work email and we'll send you a link to choose a new password."
                  : "It takes less than a minute to get started."}
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-3.5">
            {mode === "signup" && (
              <Field
                label="Full name"
                value={name}
                onValueChange={setName}
                type="text"
                placeholder="Shahriar Hossain"
                autoComplete="name"
                required
              />
            )}
            <Field
              label="Work email"
              value={email}
              onValueChange={setEmail}
              type="email"
              placeholder="you@4s.digital"
              autoComplete="email"
              required
            />
            {mode !== "forgot" && (
              <Field
                label="Password"
                value={password}
                onValueChange={setPassword}
                type="password"
                placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                minLength={6}
              />
            )}
            {mode === "signin" && (
              <div className="-mt-1 text-right">
                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                    setNotice(null);
                  }}
                  className="text-[12px] font-medium text-indigo-600 hover:text-indigo-700"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                {error}
              </p>
            )}
            {notice && (
              <p className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-[13px] leading-relaxed text-indigo-800">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-1 w-full rounded-md bg-indigo-600 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "forgot" ? "Email me a reset link" : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "New to 4S Digital?" : mode === "forgot" ? "Remembered it?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-indigo-600 hover:text-indigo-700"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setNotice(null);
              }}
            >
              {mode === "signin" ? "Create an account" : mode === "forgot" ? "Back to sign in" : "Sign in"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

type FieldProps = { label: string; onValueChange: (v: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange"
>;

function Field({ label, onValueChange, ...rest }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-slate-700">{label}</span>
      <input
        {...rest}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
    </label>
  );
}

/** Shown when the Supabase env vars are missing, instead of a blank screen. */
function SetupNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-lg border border-border bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Auth is not configured yet
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Add your Supabase project URL and publishable (anon) key to{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[12px]">apps/web/.env</code>, then
          restart the dev server:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
          VITE_SUPABASE_URL=https://&lt;project-ref&gt;.supabase.co{"\n"}
          VITE_SUPABASE_ANON_KEY=&lt;publishable key&gt;
        </pre>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Both are in the Supabase dashboard under <strong>Project Settings → API Keys</strong>.
        </p>
      </div>
    </div>
  );
}
