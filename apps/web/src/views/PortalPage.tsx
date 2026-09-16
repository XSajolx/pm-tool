import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { PortalInvoices } from "../components/PortalInvoices.js";
import { PortalProjectView } from "../components/PortalProjectView.js";

/**
 * Rows 120-122: what a client opens from their emailed link. One project shows
 * straight away; several show a chooser. Approvals (row 121) post back with the
 * same token, and every open / doc view is logged for the team (row 122).
 */
export function PortalPage() {
  const { token } = useParams({ from: "/portal/$token" });
  const home = useQuery({ queryKey: ["guest-portal", token], queryFn: () => api.getGuestPortal(token), retry: false });
  const [projectId, setProjectId] = useState<string | null>(null);
  const chosen = projectId ?? (home.data && home.data.projects.length === 1 ? home.data.projects[0]!.id : null);

  if (home.isLoading) return <p className="p-8 text-sm text-slate-500">Opening your portal…</p>;
  if (home.isError || !home.data) {
    return (
      <div className="min-h-screen bg-slate-100 px-4 py-16 text-slate-800">
        <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">This link isn't valid</h1>
          <p className="mt-2 text-sm text-slate-600">{(home.error as Error | null)?.message?.replace(/^API \d+: /, "") || "It may have expired or been revoked. Ask your project manager for a fresh link."}</p>
        </div>
      </div>
    );
  }
  if (!chosen) {
    const b = home.data.organization;
    return (
      <div className="min-h-screen bg-slate-100 text-slate-800">
        <header className="text-white" style={{ background: b?.brandColor ?? "#6366f1" }}>
          <div className="mx-auto max-w-4xl px-6 py-5">
            <p className="text-[11px] uppercase tracking-wide opacity-80">{b?.name} · Client portal</p>
            <h1 className="text-xl font-semibold">Hello{home.data.guest.name ? `, ${home.data.guest.name}` : ""}</h1>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-6">
          <p className="mb-3 text-sm text-slate-600">Your projects:</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {home.data.projects.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setProjectId(p.id)} className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-slate-300">
                  <span className="h-3 w-3 rounded-full" style={{ background: p.color }} />
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-auto text-xs capitalize text-slate-500">{p.status.replace("_", " ")}</span>
                </button>
              </li>
            ))}
            {home.data.projects.length === 0 && <li className="text-sm text-slate-500">Nothing has been shared with you yet.</li>}
          </ul>
          {home.data.invoices?.length ? (
            <div className="mt-6">
              <PortalInvoices invoices={home.data.invoices} balances={home.data.balances ?? []} accent={b?.brandColor ?? "#6366f1"} />
            </div>
          ) : null}
        </main>
      </div>
    );
  }
  return <GuestProject token={token} projectId={chosen} multi={home.data.projects.length > 1} onBack={() => setProjectId(null)} expiresAt={home.data.guest.expiresAt} />;
}

function GuestProject({ token, projectId, multi, onBack, expiresAt }: { token: string; projectId: string; multi: boolean; onBack: () => void; expiresAt: string | null }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: ["guest-project", token, projectId], queryFn: () => api.getGuestProject(token, projectId), retry: false });
  const decide = useMutation({
    mutationFn: (body: Parameters<typeof api.guestDecide>[2]) => api.guestDecide(token, projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["guest-project", token, projectId] }),
  });
  if (isLoading) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  if (isError || !data) return <p className="p-8 text-sm text-red-600">Could not load this project.</p>;
  return (
    <PortalProjectView
      data={data}
      loadDoc={(docId) => api.getGuestDoc(token, projectId, docId)}
      banner={
        (multi || expiresAt) ? (
          <div className="border-b border-slate-200 bg-white px-6 py-2 text-xs text-slate-600">
            {multi && <button type="button" onClick={onBack} className="mr-3 font-medium text-slate-800 underline">← All projects</button>}
            {expiresAt && <span>Link valid until {new Date(expiresAt).toLocaleDateString()}</span>}
          </div>
        ) : undefined
      }
      approvalSlot={(kind, id) => <DecisionButtons busy={decide.isPending} onDecide={(decision, note) => decide.mutate({ kind, id, decision, note })} error={decide.isError ? (decide.error as Error).message : null} />}
    />
  );
}

/** Row 121: approve, or request changes with a short note. */
function DecisionButtons({ onDecide, busy, error }: { onDecide: (decision: "approved" | "changes_requested", note?: string) => void; busy: boolean; error: string | null }) {
  const [mode, setMode] = useState<"idle" | "approve" | "changes">("idle");
  const [note, setNote] = useState("");
  if (mode === "idle") {
    return (
      <div className="flex items-center gap-1" data-testid="portal-decision">
        <button type="button" disabled={busy} onClick={() => setMode("approve")} className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">✓ Approve</button>
        <button type="button" disabled={busy} onClick={() => setMode("changes")} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-amber-400 hover:text-amber-800 disabled:opacity-50">Request changes</button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onDecide(mode === "approve" ? "approved" : "changes_requested", note.trim() || undefined); setMode("idle"); setNote(""); }} className="flex basis-full flex-wrap items-center gap-1" data-testid="portal-decision-form">
      <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "approve" ? "Add a note (optional)" : "What should change?"} required={mode === "changes"} className="min-w-[14rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-indigo-400" />
      <button type="submit" disabled={busy} className={mode === "approve" ? "rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50" : "rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"}>
        {mode === "approve" ? "Confirm approval" : "Send request"}
      </button>
      <button type="button" onClick={() => setMode("idle")} className="text-xs text-slate-500 hover:text-slate-800">Cancel</button>
      {error && <span className="basis-full text-xs text-red-600">{error}</span>}
    </form>
  );
}
