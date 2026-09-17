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
  Link,
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
import { QuickLogPage } from "./views/QuickLogPage.js";
import { useState } from "react";
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
import { InvoicesPage } from "./views/InvoicesPage.js";
import { InvoicePage } from "./views/InvoicePage.js";
import { PublicInvoicePage } from "./views/PublicInvoicePage.js";
import { SchedulesPage } from "./views/SchedulesPage.js";
import { ContractsPage } from "./views/ContractsPage.js";
import { ExpensesPage } from "./views/ExpensesPage.js";
import { PnlPage } from "./views/PnlPage.js";
import { ProfitFirstPage } from "./views/ProfitFirstPage.js";
import { TaxPage } from "./views/TaxPage.js";
import { AccountingPage } from "./views/AccountingPage.js";
import { ContractPage } from "./views/ContractPage.js";
import { PublicContractPage } from "./views/PublicContractPage.js";
import { SchedulePage } from "./views/SchedulePage.js";
import { SettingsPage } from "./views/SettingsPage.js";
import { MyWorkPage } from "./views/MyWorkPage.js";
import { DocsPage, DocPage } from "./views/DocsPage.js";
import { DashboardsPage } from "./views/DashboardsPage.js";
import { OverviewPage } from "./views/OverviewPage.js";
import { PortalPreviewPage } from "./views/PortalPreviewPage.js";
import { PortalPage } from "./views/PortalPage.js";
import { TrashPage } from "./views/TrashPage.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { GlobalSearch } from "./components/GlobalSearch.js";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  // Client-facing pages (proposal links, rows 58-59) live outside the login gate.
  // Rows 65/55/79/120: public pages - share links, proposals, password reset, the client portal (but not the team's preview).
  if (pathname.startsWith("/p/") || pathname.startsWith("/d/") || pathname.startsWith("/i/") || pathname.startsWith("/c/") || pathname === "/reset-password" || (pathname.startsWith("/portal/") && !pathname.startsWith("/portal/preview/"))) return <Outlet />;

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
        {/* Row 96: the sidebar is desktop-only; phones get a slim bar with a drawer and a one-tap "Log time". */}
        <div className="hidden md:flex">
          <Sidebar />
        </div>
        {menuOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMenuOpen(false)} />
            <div className="absolute inset-y-0 left-0 shadow-xl" onClick={() => setMenuOpen(false)}>
              <Sidebar />
            </div>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MobileBar onMenu={() => setMenuOpen(true)} />
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** Row 96: phone header - menu, workspace name, Inbox, and the three-tap time logger. */
function MobileBar({ onMenu }: { onMenu: () => void }) {
  const { pathname } = useLocation();
  // Row 128: create a task and search from the phone bar, no sidebar needed.
  const [quickAdd, setQuickAdd] = useState(false);
  const [search, setSearch] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-[#fbfbfa] px-3 py-2 md:hidden">
      <QuickAdd open={quickAdd} onClose={() => setQuickAdd(false)} />
      {search && <GlobalSearch onClose={() => setSearch(false)} />}
      <button type="button" onClick={onMenu} aria-label="Menu" className="flex h-9 w-9 items-center justify-center rounded-md text-slate-700 hover:bg-muted">
        ☰
      </button>
      <span className="text-sm font-semibold text-slate-800">4S</span>
      <span className="flex-1" />
      <button type="button" onClick={() => setSearch(true)} aria-label="Search" className="rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-muted">⌕</button>
      <button type="button" onClick={() => setQuickAdd(true)} className="rounded-md border border-indigo-300 px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50" data-testid="mobile-new-task">＋ Task</button>
      <Link to="/inbox" className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-muted">Inbox</Link>
      <Link to="/log" className={pathname === "/log" ? "rounded-md bg-indigo-100 px-3 py-1.5 text-xs font-semibold text-indigo-800" : "rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"}>
        ⚡ Log time
      </Link>
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
const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/overview", component: OverviewPage });
const portalPreviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/portal/preview/$projectId", component: PortalPreviewPage });
const portalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/portal/$token", component: PortalPage });
const trashRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trash", component: TrashPage });
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
const quickLogRoute = createRoute({ getParentRoute: () => rootRoute, path: "/log", component: QuickLogPage });
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
const invoicesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/invoices", component: InvoicesPage });
const invoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/invoices/$invoiceId", component: InvoicePage });
const schedulesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/recurring", component: SchedulesPage });
const scheduleRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/recurring/$scheduleId", component: SchedulePage });
const taxRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/tax", component: TaxPage });
const accountingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/accounting", component: AccountingPage });
const profitFirstRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/profit-first", component: ProfitFirstPage });
const pnlRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/pnl", component: PnlPage });
const expensesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finance/expenses", component: ExpensesPage });
const contractsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/contracts", component: ContractsPage });
const contractRoute = createRoute({ getParentRoute: () => rootRoute, path: "/crm/contracts/$contractId", component: ContractPage });
const publicContractRoute = createRoute({ getParentRoute: () => rootRoute, path: "/c/$token", component: PublicContractPage });
const publicInvoiceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/i/$token", component: PublicInvoicePage });
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
  quickLogRoute,
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
  invoicesRoute,
  invoiceRoute,
  publicInvoiceRoute,
  contractsRoute,
  expensesRoute,
  pnlRoute,
  profitFirstRoute,
  taxRoute,
  accountingRoute,
  contractRoute,
  publicContractRoute,
  schedulesRoute,
  scheduleRoute,
  resetPasswordRoute,
  taskOpenRoute,
  docsRoute,
  docRoute,
  dashboardsRoute,
  overviewRoute,
  portalPreviewRoute,
  portalRoute,
  trashRoute,
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
