import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth.js";

/**
 * Shown to a signed-in user who belongs to no organization yet — every other
 * route is org-scoped, so there is nothing to render until one exists. Creating
 * it makes them its owner.
 */
export function CreateOrgPage() {
  const { user, createOrganization, signOut } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createOrganization(name.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            4S
          </span>
          <span className="text-sm font-semibold text-slate-700">4S Digital</span>
        </div>

        <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">
          Create your workspace
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Signed in as {user?.email}. Name the workspace your team will share —
          you can invite people once it exists.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-3.5">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-slate-700">
              Workspace name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="4S Digital"
              required
              maxLength={255}
              className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            />
          </label>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="w-full rounded-md bg-indigo-600 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-5 text-sm text-muted-foreground hover:text-slate-700"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
