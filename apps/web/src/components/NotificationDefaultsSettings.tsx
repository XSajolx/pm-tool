import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { CHANNELS, NOTIF_TYPE_ROWS } from "../views/HomePage.js";
import { QuietHoursForm } from "./QuietHoursForm.js";

/**
 * Row 111: what every member starts with (per event type and channel) plus the
 * workspace quiet window. A person's own switches always win over these.
 */
export function NotificationDefaultsSettings({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notification-workspace-defaults"], queryFn: api.getWorkspaceNotificationDefaults });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateWorkspaceNotificationDefaults>[0]) => api.updateWorkspaceNotificationDefaults(patch),
    onSuccess: (next) => {
      qc.setQueryData(["notification-workspace-defaults"], next);
      qc.invalidateQueries({ queryKey: ["notification-preferences"] });
    },
  });
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="max-w-2xl" data-testid="notification-defaults">
      <h1 className="text-lg font-semibold text-slate-900">Notification defaults & quiet hours</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        New members start with these switches; anyone can still change their own from the inbox. Quiet hours hold back email and push for the whole workspace.
        {!data.emailConfigured && <span className="ml-1 text-amber-700">Email isn't configured on the server yet, so email switches save but nothing goes out.</span>}
      </p>
      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#fbfbfa] text-[11px] text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Event</th>
              {CHANNELS.map((c) => (
                <th key={c.key} className="w-16 px-1 py-2 text-center font-medium">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIF_TYPE_ROWS.map((row) => (
              <tr key={row.key} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-1.5 text-slate-700">{row.label}</td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-1 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={data.channels[row.key][c.key]}
                      disabled={!canEdit}
                      onChange={(e) => save.mutate({ channels: { [row.key]: { [c.key]: e.target.checked } } })}
                      className="accent-indigo-600"
                      aria-label={`${row.label} ${c.label}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 rounded-lg border border-border bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Workspace quiet hours</h2>
        <QuietHoursForm value={data.quietHours} disabled={!canEdit} onChange={(patch) => save.mutate({ quietHours: patch })} />
      </div>
      {save.isError && <p className="mt-2 text-xs text-red-600">{(save.error as Error).message}</p>}
    </div>
  );
}
