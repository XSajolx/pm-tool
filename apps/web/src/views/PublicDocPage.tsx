import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { DocReadOnly } from "../components/doc/DocReadOnly.js";

/** Row 65: a shared doc, read-only, with internal-only blocks already stripped by the API. */
export function PublicDocPage() {
  const { token } = useParams({ from: "/d/$token" });
  const { data, isLoading, isError } = useQuery({ queryKey: ["public-doc", token], queryFn: () => api.getPublicDoc(token), retry: false });
  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-800">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm sm:px-10">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : isError || !data ? (
          <>
            <h1 className="text-lg font-semibold text-slate-900">This link isn't valid</h1>
            <p className="mt-1 text-sm text-slate-600">Sharing may have been switched off. Ask the sender for a fresh link.</p>
          </>
        ) : (
          <>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {data.organization ?? "Shared document"}
              {data.project ? ` · ${data.project}` : ""}
              {data.reviewStatus === "approved" ? " · Approved" : ""}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              {data.icon ? `${data.icon} ` : ""}
              {data.title}
            </h1>
            <p className="mb-6 mt-1 flex items-center gap-3 text-xs text-slate-500">
              <span>Last updated {new Date(data.updatedAt).toLocaleDateString()}</span>
              <a href={api.publicDocPdfUrl(token)} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50">
                Download PDF
              </a>
            </p>
            <DocReadOnly content={data.content} body={data.body} settings={data.settings} />
          </>
        )}
      </div>
      <p className="mx-auto mt-4 max-w-3xl text-center text-[11px] text-slate-400">Shared from 4S PM Tool</p>
    </div>
  );
}
