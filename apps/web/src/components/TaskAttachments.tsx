import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Attachment } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/**
 * Row 2: files on a task. Upload from the button, drop onto the block, or
 * paste; images preview inline, everything else is a chip that opens the file.
 */
function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}
function icon(mime: string, name: string) {
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜️";
  if (mime.includes("sheet") || /\.(xlsx?|csv)$/i.test(name)) return "📊";
  if (mime.includes("presentation") || /\.pptx?$/i.test(name)) return "📽️";
  if (mime.includes("word") || /\.docx?$/i.test(name)) return "📝";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  return "📄";
}

export function TaskAttachments({ taskId, canEdit = true }: { taskId: string; canEdit?: boolean }) {
  const qc = useQueryClient();
  const key = ["task-files", taskId];
  const { data: files = [] } = useQuery({ queryKey: key, queryFn: () => api.getTaskFiles(taskId) });
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    setBusy((n) => n + arr.length);
    for (const f of arr) {
      try {
        await api.uploadFile(f, { taskId });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const remove = useMutation({ mutationFn: (id: string) => api.deleteFile(id), onSuccess: () => qc.invalidateQueries({ queryKey: key }), onError: (e: Error) => setError(e.message) });
  const images = files.filter((f) => f.mimeType.startsWith("image/"));
  const others = files.filter((f) => !f.mimeType.startsWith("image/"));

  return (
    <div
      className={cn("border-t border-border px-5 py-3", over && "bg-indigo-50/60")}
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (!canEdit) return; e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); }}
      onPaste={(e) => { if (canEdit && e.clipboardData.files.length) void upload(e.clipboardData.files); }}
      data-testid="task-attachments"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attachments</h3>
        {files.length > 0 && <span className="text-[11px] text-muted-foreground">{files.length}</span>}
        {busy > 0 && <span className="text-[11px] text-indigo-700">Uploading {busy}…</span>}
        {canEdit && (
          <>
            <button type="button" onClick={() => input.current?.click()} className="ml-auto rounded-md border border-border bg-white px-2 py-1 text-xs text-slate-700 hover:border-indigo-300 hover:text-indigo-700" data-testid="task-attach">
              📎 Attach
            </button>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>
      {files.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{canEdit ? "Drop files here, paste a screenshot, or attach from your computer." : "No attachments."}</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((f) => (
                <div key={f.id} className="group relative">
                  <a href={f.url} target="_blank" rel="noreferrer" title={`${f.filename} · ${fmtSize(f.sizeBytes)}`}>
                    <img src={f.url} alt={f.filename} className="max-h-32 rounded-md border border-border object-cover" loading="lazy" />
                  </a>
                  {canEdit && <button type="button" onClick={() => remove.mutate(f.id)} className="absolute right-1 top-1 hidden rounded bg-white/90 px-1 text-[10px] text-slate-600 shadow group-hover:block hover:text-red-600" title="Remove">×</button>}
                </div>
              ))}
            </div>
          )}
          {others.map((f: Attachment) => (
            <div key={f.id} className="flex items-center gap-2 rounded-md border border-border bg-[#fbfbfa] px-2.5 py-1.5 text-xs text-slate-700">
              <span className="text-base">{icon(f.mimeType, f.filename)}</span>
              <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium hover:text-indigo-700 hover:underline">{f.filename}</a>
              <span className="shrink-0 text-muted-foreground">{fmtSize(f.sizeBytes)}{f.uploadedBy ? ` · ${f.uploadedBy.name}` : ""}</span>
              {canEdit && <button type="button" onClick={() => remove.mutate(f.id)} className="text-slate-400 hover:text-red-600" title="Remove">×</button>}
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
