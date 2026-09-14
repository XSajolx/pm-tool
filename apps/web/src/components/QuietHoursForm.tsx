import type { QuietHours } from "../lib/api.js";

/** Row 111: one small form for a quiet window, used for the workspace and for a person's override. */
export function QuietHoursForm({ value, disabled, onChange }: { value: QuietHours; disabled?: boolean; onChange: (patch: Partial<QuietHours>) => void }) {
  const field = "rounded-md border border-border bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 disabled:opacity-60";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700" data-testid="quiet-hours">
      <label className="inline-flex items-center gap-1.5">
        <input type="checkbox" checked={value.enabled} disabled={disabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="accent-indigo-600" />
        Quiet hours
      </label>
      <span>from</span>
      <input type="time" value={value.start} disabled={disabled || !value.enabled} onChange={(e) => e.target.value && onChange({ start: e.target.value })} className={field} aria-label="Quiet from" />
      <span>to</span>
      <input type="time" value={value.end} disabled={disabled || !value.enabled} onChange={(e) => e.target.value && onChange({ end: e.target.value })} className={field} aria-label="Quiet until" />
      <label className="inline-flex items-center gap-1.5">
        <input type="checkbox" checked={value.weekends} disabled={disabled || !value.enabled} onChange={(e) => onChange({ weekends: e.target.checked })} className="accent-indigo-600" />
        all weekend
      </label>
      <input
        value={value.timezone}
        disabled={disabled || !value.enabled}
        onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== value.timezone && onChange({ timezone: e.target.value.trim() })}
        onChange={() => undefined}
        list="tz-list"
        className={`${field} w-36`}
        aria-label="Timezone"
        title="IANA timezone, e.g. Asia/Dhaka"
        key={value.timezone}
        defaultValue={value.timezone}
      />
      <datalist id="tz-list">
        {["Asia/Dhaka", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"].map((z) => <option key={z} value={z} />)}
      </datalist>
      <span className="text-muted-foreground">No email or push in the window; the inbox still fills up.</span>
    </div>
  );
}
