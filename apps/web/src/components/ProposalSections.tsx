import type { ProposalSection } from "../lib/api.js";

/** Row 56: the fixed-section editor shared by proposals and their templates. */
export function ProposalSectionsEditor({ sections, onChange, disabled }: { sections: ProposalSection[]; onChange: (next: ProposalSection[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<ProposalSection>) => onChange(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {sections.map((s, i) => (
        <div key={`${s.key}-${i}`} className="rounded-lg border border-border bg-white">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="w-5 text-center text-[11px] text-muted-foreground">{i + 1}</span>
            <input
              value={s.title}
              disabled={disabled}
              onChange={(e) => set(i, { title: e.target.value })}
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none disabled:opacity-70"
              placeholder="Section title"
            />
            {!disabled && (
              <div className="flex items-center gap-0.5 text-[11px] text-slate-400">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1 hover:bg-muted disabled:opacity-30" title="Move up">▲</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === sections.length - 1} className="rounded px-1 hover:bg-muted disabled:opacity-30" title="Move down">▼</button>
                <button type="button" onClick={() => onChange(sections.filter((_, j) => j !== i))} className="rounded px-1 hover:bg-muted hover:text-red-600" title="Remove section">✕</button>
              </div>
            )}
          </div>
          <textarea
            value={s.body}
            disabled={disabled}
            onChange={(e) => set(i, { body: e.target.value })}
            rows={Math.min(14, Math.max(3, s.body.split("\n").length + 1))}
            className="w-full resize-y bg-transparent px-3 py-2 text-sm leading-relaxed text-slate-700 outline-none disabled:opacity-70"
            placeholder="Write this section…"
          />
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={() => onChange([...sections, { key: `s${Date.now()}`, title: "New section", body: "" }])}
          className="rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-slate-600 hover:bg-muted"
        >
          + Add section
        </button>
      )}
    </div>
  );
}

/** Read-only rendering (client page, preview). */
export function ProposalSectionsView({ sections }: { sections: ProposalSection[] }) {
  return (
    <div className="space-y-6">
      {sections.map((s, i) => (
        <section key={`${s.key}-${i}`}>
          <h2 className="mb-1.5 text-base font-semibold text-slate-900">{s.title}</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{s.body || "—"}</p>
        </section>
      ))}
    </div>
  );
}
