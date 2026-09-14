/**
 * Row 82: the four workspace roles. Every member has exactly one (the
 * memberships table is unique per person per workspace). The enum values are
 * stable API identifiers; the labels are what people see.
 */
export type WorkspaceRole = "owner" | "admin" | "member" | "guest";

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Project manager",
  member: "Team member",
  guest: "Client guest",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Runs the workspace: billing, settings, ownership transfer. Exactly one per workspace.",
  admin: "Sets up projects, people and settings; approves timesheets and sign-offs.",
  member: "Does the work: tasks, time, docs and chat on the projects they're on.",
  guest: "A client: sees only what's shared with them on their projects, read-mostly.",
};

export const ASSIGNABLE_ROLES: WorkspaceRole[] = ["admin", "member", "guest"];

export function roleLabel(role: string | null | undefined) {
  return role ? (ROLE_LABELS[role as WorkspaceRole] ?? role) : "";
}

/** What each role can do - the matrix shown in Settings › People & roles. */
export const PERMISSION_MATRIX: { area: string; owner: string; admin: string; member: string; guest: string }[] = [
  { area: "Workspace settings, roles, billing", owner: "✓", admin: "✓ (not ownership)", member: "–", guest: "–" },
  { area: "Invite / remove people", owner: "✓", admin: "✓", member: "–", guest: "–" },
  { area: "Create projects, spaces, stages", owner: "✓", admin: "✓", member: "–", guest: "–" },
  { area: "Tasks, time, docs, chat on their projects", owner: "✓", admin: "✓", member: "✓", guest: "Read + comment" },
  { area: "Approve timesheets & milestone sign-offs", owner: "✓", admin: "✓", member: "–", guest: "–" },
  { area: "CRM (companies, deals, proposals)", owner: "✓", admin: "✓", member: "✓", guest: "–" },
  { area: "Client-visible docs & milestones", owner: "✓", admin: "✓", member: "✓", guest: "✓ (shared only)" },
  { area: "Delete tasks, projects", owner: "✓", admin: "✓", member: "–", guest: "–" },
];
