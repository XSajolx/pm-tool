import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspacePage } from "./views/WorkspacePage.js";
import { ChatPage } from "./views/ChatPage.js";
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

/**
 * The gate every route passes through. Rather than redirecting to /login we swap
 * what renders at the current URL — so a deep link survives sign-in and lands
 * where the user was headed instead of dumping them on the index.
 */
function Protected() {
  const { session, user, memberships, loading } = useAuth();

  if (loading) return <Splash />;
  if (!session) return <AuthPage />;
  // Signed in, but `/auth/me` hasn't answered yet.
  if (!user) return <Splash />;
  if (!memberships.length) return <CreateOrgPage />;

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
  ): { task?: string; view?: "list" | "board" | "table" } => ({
    ...(typeof s.task === "string" ? { task: s.task } : {}),
    ...(s.view === "list" || s.view === "board" || s.view === "table" ? { view: s.view } : {}),
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
const dealsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/deals", component: DealsPage });
const estimatesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/estimates", component: EstimatesPage });
const estimateRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/estimates/$estimateId", component: EstimatePage });
const meetingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/meetings", component: MeetingsPage });

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
  taskOpenRoute,
  docsRoute,
  docRoute,
  dashboardsRoute,
  spaceRoute,
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
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
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
