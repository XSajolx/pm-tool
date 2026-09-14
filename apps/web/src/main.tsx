import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspacePage } from "./views/WorkspacePage.js";
import { ChatPage } from "./views/ChatPage.js";
import { ResetPasswordPage } from "./views/ResetPasswordPage.js";
import { MfaEnrollPage, MfaVerifyPage } from "./views/MfaPages.js";
import { HomePage } from "./views/HomePage.js";
import { IntakePage } from "./views/IntakePage.js";
import { ProjectsPage } from "./views/ProjectsPage.js";
import { ProjectPage } from "./views/ProjectPage.js";
import { TimeTrackingPage } from "./views/TimeTrackingPage.js";
import { TimesheetPage } from "./views/TimesheetPage.js";
import { ResourcingPage } from "./views/ResourcingPage.js";
import { CompaniesPage } from "./views/CompaniesPage.js";
import { CompanyPage } from "./views/CompanyPage.js";
import { ContactsPage } from "./views/ContactsPage.js";
import { DealsPage } from "./views/DealsPage.js";
import { EstimatesPage } from "./views/EstimatesPage.js";
import { EstimatePage } from "./views/EstimatePage.js";
import { MeetingsPage } from "./views/MeetingsPage.js";
import { ProposalsPage } from "./views/ProposalsPage.js";
import { ProposalPage } from "./views/ProposalPage.js";
import { PublicProposalPage } from "./views/PublicProposalPage.js";
import { PublicDocPage } from "./views/PublicDocPage.js";
import { SettingsPage } from "./views/SettingsPage.js";
import { MyWorkPage } from "./views/MyWorkPage.js";
import { DocsPage, DocPage } from "./views/DocsPage.js";
import { DashboardsPage } from "./views/DashboardsPage.js";
import { TaskOpenPage } from "./views/TaskOpenPage.js";
import { SpaceOverviewPage } from "./views/SpaceOverviewPage.js";
import { AuthPage } from "./views/AuthPage.js";
import { CreateOrgPage } from "./views/CreateOrgPage.js";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { api, ApiError, API_CONFIGURED } from "./lib/api.js";
import { NotFound } from "./components/NotFound.js";
import "./index.css";
import "./doc-editor.css";

/**
 * The gate every route passes through. Rather than redirecting to /login we swap
 * what renders at the current URL — so a deep link survives sign-in and lands
 * where the user was headed instead of dumping them on the index.
 */
function Protected() {
  const { session, user, memberships, loading, mfa, activeOrgId } = useAuth();
  const { pathname } = useLocation();

  // Client-facing pages (proposal links, rows 58-59) live outside the login gate.
  if (pathname.startsWith("/p/") || pathname.startsWith("/d/") || pathname === "/reset-password") return <Outlet />;

  if (loading) return <Splash />;
  if (!session) return <AuthPage />;
  // Signed in, but `/auth/me` hasn't answered yet.
  if (!user) return <Splash />;
  // Row 81: enrolled users prove the second factor every session; required roles must enrol.
  if (mfa && mfa.enrolled && !mfa.verified) return <MfaVerifyPage />;
  if (mfa && !mfa.enrolled && memberships.find((m) => m.organizationId === activeOrgId)?.mfaRequired) return <MfaEnrollPage />;
  // Row 86: deactivated in the active workspace - say so instead of a wall of 403s.
  const active = memberships.find((m) => m.organizationId === activeOrgId);
  if (active?.accessEnded) return <AccessEnded orgName={active.organization.name} />;
  if (!memberships.length && API_CONFIGURED) return <CreateOrgPage />;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {!API_CONFIGURED && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-800">
          Preview build — the API isn't connected yet, so lists, CRM and time screens can't load data.
          Sign-in works; everything else lights up once <code>VITE_API_URL</code> points at a hosted API.
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <Outlet />
      </div>
    </div>
  );
}

function AccessEnded({ orgName }: { orgName: string }) {
  const { signOut, memberships, switchOrg } = useAuth();
  const others = memberships.filter((m) => !m.accessEnded);
  return (
    <div className="flex h-screen w-full items-center justify-center px-6">
      <div className="max-w-md rounded-lg border border-border bg-white p-6 text-center shadow-sm">
        <p className="text-2xl">👋</p>
        <h1 className="mt-2 text-lg font-semibold text-slate-900">Your access to {orgName} has ended</h1>
        <p className="mt-1 text-sm text-muted-foreground">An admin deactivated your membership. Your work and messages stay with the team.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {others.map((m) => (
            <button key={m.organizationId} type="button" onClick={() => switchOrg(m.organizationId)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
              Open {m.organization.name}
            </button>
          ))}
          <button type="button" onClick={() => void signOut()} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex h-screen w-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

const rootRoute = createRootRoute({ component: Protected, notFoundComponent: () => <NotFound /> });

/** Landing: jump to the first available list. */
function Index() {
  const navigate = useNavigate();
  const { data: spaces = [], isLoading } = useQuery({
    queryKey: ["spaces"],
    queryFn: api.getSpaces,
  });

  useEffect(() => {
    const firstList = spaces.flatMap((s) => s.lists)[0];
    if (firstList) navigate({ to: "/l/$listId", params: { listId: firstList.id } });
  }, [spaces, navigate]);

  return (
    <div className="flex h-screen flex-1 items-center justify-center text-sm text-muted-foreground">
      {isLoading ? "Loading workspace…" : "Select a list from the sidebar to get started."}
    </div>
  );
}

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Index });
const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/l/$listId",
  component: WorkspacePage,
  // Optional key, so plain links to a list don't have to spell out `search`.
  validateSearch: (
    s: Record<string, unknown>,
  ): { task?: string; view?: "list" | "board" | "table" | "calendar" } => ({
    ...(typeof s.task === "string" ? { task: s.task } : {}),
    ...(s.view === "list" || s.view === "board" || s.view === "table" || s.view === "calendar" ? { view: s.view } : {}),
  }),
});
const taskOpenRoute = createRoute({ getParentRoute: () => rootRoute, path: "/t/$taskId", component: TaskOpenPage });
const docsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs", component: DocsPage });
const docRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$docId", component: DocPage });
const dashboardsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboards", component: DashboardsPage });
const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/s/$spaceId", component: SpaceOverviewPage });
const chatIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatPage,
});
const chatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$channelId",
  component: ChatPage,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: HomePage,
});
const intakeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/intake",
  component: IntakePage,
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectPage,
});
const timeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/time",
  component: TimeTrackingPage,
});
const timesheetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/timesheets",
  component: TimesheetPage,
});
const resourcingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/resourcing",
  component: ResourcingPage,
});
const companiesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/companies", component: CompaniesPage });
const companyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/companies/$companyId", component: CompanyPage });
const contactsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/contacts", component: ContactsPage });
const dealsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/crm/deals",
  component: DealsPage,
  // ?deal=<id> opens that deal's drawer (inbox follow-up reminders link here).
  validateSearch: (s: Record<string, unknown>): { deal?: string } => (typeof s.deal === "string" ? { deal: s.deal } : {}),
});
const estimatesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/estimates", component: EstimatesPage });
const estimateRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/estimates/$estimateId", component: EstimatePage });
const meetingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/meetings", component: MeetingsPage });
const proposalsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/proposals", component: ProposalsPage });
const proposalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/proposals/$proposalId", component: ProposalPage });
const publicProposalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/p/$token", component: PublicProposalPage });
const publicDocRoute = createRoute({ getParentRoute: () => rootRoute, path: "/d/$token", component: PublicDocPage });
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reset-password", component: ResetPasswordPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const myWorkRoute = createRoute({ getParentRoute: () => rootRoute, path: "/my-work", component: MyWorkPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  listRoute,
  chatIndexRoute,
  chatChannelRoute,
  inboxRoute,
  intakeRoute,
  projectsRoute,
  projectRoute,
  timeRoute,
  timesheetRoute,
  resourcingRoute,
  companiesRoute,
  companyRoute,
  contactsRoute,
  dealsRoute,
  estimatesRoute,
  estimateRoute,
  meetingsRoute,
  proposalsRoute,
  proposalRoute,
  publicProposalRoute,
  publicDocRoute,
  resetPasswordRoute,
  taskOpenRoute,
  docsRoute,
  docRoute,
  dashboardsRoute,
  spaceRoute,
  settingsRoute,
  myWorkRoute,
]);
// Vite's BASE_URL is "/" locally and "/pm-tool/" on GitHub Pages.
const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // A 4xx is an answer, not a blip: retrying a 404 three times just makes
      // "not found" take seven seconds to appear. Network-ish failures still retry.
      retry: (count, err) =>
        !(err instanceof ApiError && (err.status === 0 || (err.status >= 400 && err.status < 500))) &&
        count < 2,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
