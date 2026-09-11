import { Link } from "@tanstack/react-router";

/**
 * Rendered inside the app shell for a URL that resolves to nothing — an unknown
 * route, or a detail page whose record was deleted or belongs to another org.
 */
export function NotFound({ what = "page" }: { what?: string }) {
  return (
    <div className="flex h-screen flex-1 flex-col items-center justify-center gap-2 text-center">
      <span className="text-3xl">🔍</span>
      <p className="text-sm font-medium text-slate-800">That {what} could not be found</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        It may have been deleted, or the link belongs to a different workspace.
      </p>
      <Link to="/" className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
        Back to workspace
      </Link>
    </div>
  );
}
