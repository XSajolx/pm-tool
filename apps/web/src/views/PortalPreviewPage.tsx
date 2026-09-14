import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { PortalProjectView } from "../components/PortalProjectView.js";

/** Row 118: "Preview as client" - the team sees the portal exactly as a guest would. */
export function PortalPreviewPage() {
  const { projectId } = useParams({ from: "/portal/preview/$projectId" });
  const { data, isLoading, isError } = useQuery({ queryKey: ["portal-preview", projectId], queryFn: () => api.getPortalPreview(projectId) });
  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading preview…</p>;
  if (isError || !data) return <p className="p-6 text-sm text-red-600">Could not load the client view.</p>;
  return (
    <div className="flex-1 overflow-y-auto">
      <PortalProjectView
        data={data}
        loadDoc={(docId) => api.getPortalPreviewDoc(projectId, docId)}
        banner={
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-center text-xs text-amber-800" data-testid="portal-preview-banner">
            Preview as client - this is what a guest sees. Nothing internal is included.{" "}
            <Link to="/projects/$projectId" params={{ projectId }} className="font-medium underline">Back to the project</Link>
          </div>
        }
      />
    </div>
  );
}
