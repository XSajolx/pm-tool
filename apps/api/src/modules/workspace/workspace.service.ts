import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { accessEnded } from "../auth/auth.service.js";
import { and, asc, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  timeEntries,
  taskAssignees,
  invitations,
  organizations,
  bookmarks,
  documents,
  folders,
  lists,
  memberships,
  projects,
  spaces,
  statuses,
  tags,
  taskTags,
  tasks,
  users,
} from "../../db/schema.js";
import type { Role } from "../auth/auth.types.js";

type StatusCategory = "not_started" | "active" | "done" | "closed";

/** The statuses every new space starts with — same set the seed and Projects use. */
const DEFAULT_STATUSES = [
  { name: "To Do", category: "not_started", color: "#94a3b8", position: 1 },
  { name: "In Progress", category: "active", color: "#3b82f6", position: 2 },
  { name: "In Review", category: "active", color: "#f59e0b", position: 3 },
  { name: "Done", category: "done", color: "#22c55e", position: 4 },
] as const;

@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The sidebar tree: spaces → (folders →) lists, all tenant-scoped. */
  async spaceTree(orgId: string) {
    const rows = await this.db.query.spaces.findMany({
      where: and(eq(spaces.organizationId, orgId), isNull(spaces.archivedAt)),
      with: {
        folders: { with: { lists: true } },
        lists: true,
      },
      orderBy: (s) => [asc(s.position)],
    });

    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      // Lists sitting directly on the space (not inside a folder).
      lists: s.lists
        .filter((l) => !l.folderId)
        .sort((a, b) => a.position - b.position)
        .map((l) => ({ id: l.id, name: l.name })),
      folders: s.folders.map((f) => ({
        id: f.id,
        name: f.name,
        lists: f.lists
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ id: l.id, name: l.name })),
      })),
    }));
  }

  /** A new space is usable immediately: default statuses plus a first list. */
  async createSpace(orgId: string, dto: { name: string; color?: string }) {
    return this.db.transaction(async (tx) => {
      const [space] = await tx
        .insert(spaces)
        .values({
          organizationId: orgId,
          name: dto.name,
          color: dto.color ?? "#6366f1",
          position: Date.now(),
        })
        .returning();
      await tx.insert(statuses).values(
        DEFAULT_STATUSES.map((s) => ({ ...s, organizationId: orgId, spaceId: space!.id })),
      );
      const [list] = await tx
        .insert(lists)
        .values({ organizationId: orgId, spaceId: space!.id, name: "Tasks", position: 1 })
        .returning();
      return { id: space!.id, name: space!.name, color: space!.color, firstListId: list!.id };
    });
  }

  async createList(orgId: string, spaceId: string, name: string) {
    await this.assertSpace(orgId, spaceId);
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${lists.position}), 0)` })
      .from(lists)
      .where(eq(lists.spaceId, spaceId));
    const [list] = await this.db
      .insert(lists)
      .values({ organizationId: orgId, spaceId, name, position: Number(max?.m ?? 0) + 1 })
      .returning();
    return { id: list!.id, name: list!.name, spaceId };
  }

  async statusesForSpace(orgId: string, spaceId: string) {
    return this.db.query.statuses.findMany({
      where: and(eq(statuses.organizationId, orgId), eq(statuses.spaceId, spaceId)),
      orderBy: (s) => [asc(s.position)],
    });
  }

  async createStatus(orgId: string, spaceId: string, dto: { name: string; color?: string; category?: StatusCategory }) {
    await this.assertSpace(orgId, spaceId);
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${statuses.position}), 0)` })
      .from(statuses)
      .where(eq(statuses.spaceId, spaceId));
    const [row] = await this.db
      .insert(statuses)
      .values({
        organizationId: orgId,
        spaceId,
        name: dto.name.trim(),
        color: dto.color ?? "#6b7280",
        category: dto.category ?? "active",
        position: Number(max?.m ?? 0) + 1,
      })
      .returning();
    return row!;
  }

  async updateStatus(orgId: string, id: string, dto: { name?: string; color?: string; category?: StatusCategory }) {
    const [row] = await this.db
      .update(statuses)
      .set({ ...dto, name: dto.name?.trim() })
      .where(and(eq(statuses.id, id), eq(statuses.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Status not found");
    return row;
  }

  /** Positions follow the order of `ids`; ids from another space are ignored. */
  async reorderStatuses(orgId: string, spaceId: string, ids: string[]) {
    await this.assertSpace(orgId, spaceId);
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx
          .update(statuses)
          .set({ position: i + 1 })
          .where(and(eq(statuses.id, id), eq(statuses.spaceId, spaceId), eq(statuses.organizationId, orgId)));
      }
    });
    return this.statusesForSpace(orgId, spaceId);
  }

  async deleteStatus(orgId: string, id: string, reassignTo?: string) {
    const status = await this.db.query.statuses.findFirst({
      where: and(eq(statuses.id, id), eq(statuses.organizationId, orgId)),
    });
    if (!status) throw new NotFoundException("Status not found");
    const siblings = await this.statusesForSpace(orgId, status.spaceId);
    if (siblings.length <= 1) throw new BadRequestException("A space needs at least one status");
    const [cnt] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.statusId, id), isNull(tasks.archivedAt)));
    const n = Number(cnt?.n ?? 0);
    const inUse = n > 0;
    if (inUse) {
      const target = siblings.find((s) => s.id === reassignTo);
      if (!target) throw new BadRequestException("Tasks use this status — pick another status to move them to");
      await this.db.update(tasks).set({ statusId: target.id }).where(eq(tasks.statusId, id));
    }
    await this.db.delete(statuses).where(eq(statuses.id, id));
    return { id, deleted: true, movedTasks: n };
  }

  /* ---- Tags are workspace-wide (row 30): one colour-coded set, usable in every project ---- */

  async tagsForOrg(orgId: string) {
    return this.db.query.tags.findMany({
      where: and(eq(tags.organizationId, orgId), isNull(tags.archivedAt)),
      orderBy: (t) => [asc(t.name)],
    });
  }

  /** Tags with how many live tasks use each — for the Settings manager. */
  async tagsWithUsage(orgId: string) {
    const rows = await this.tagsForOrg(orgId);
    if (!rows.length) return [];
    const counts = await this.db
      .select({ tagId: taskTags.tagId, n: sql<number>`count(*)::int` })
      .from(taskTags)
      .innerJoin(tasks, eq(tasks.id, taskTags.taskId))
      .where(and(inArray(taskTags.tagId, rows.map((t) => t.id)), isNull(tasks.archivedAt)))
      .groupBy(taskTags.tagId);
    const byId = new Map(counts.map((c) => [c.tagId, c.n]));
    return rows.map((t) => ({ ...t, taskCount: byId.get(t.id) ?? 0 }));
  }

  /** Case-insensitive by name: "Bug" and "bug" are the same tag. */
  async createTag(orgId: string, dto: { name: string; color?: string }) {
    const name = dto.name.trim();
    const existing = await this.db.query.tags.findFirst({
      where: and(eq(tags.organizationId, orgId), sql`lower(${tags.name}) = lower(${name})`),
    });
    if (existing) {
      if (existing.archivedAt) {
        const [revived] = await this.db.update(tags).set({ archivedAt: null, color: dto.color ?? existing.color }).where(eq(tags.id, existing.id)).returning();
        return revived!;
      }
      return existing;
    }
    const [row] = await this.db
      .insert(tags)
      .values({ organizationId: orgId, spaceId: null, name, color: dto.color ?? "#6b7280" })
      .returning();
    return row!;
  }

  async updateTag(orgId: string, id: string, dto: { name?: string; color?: string }) {
    const [row] = await this.db
      .update(tags)
      .set({ ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), ...(dto.color !== undefined ? { color: dto.color } : {}), updatedAt: new Date() })
      .where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Tag not found");
    return row;
  }

  /** Move every use of `id` onto `intoId`, then retire `id`. */
  async mergeTag(orgId: string, id: string, intoId: string) {
    if (id === intoId) throw new BadRequestException("Pick a different tag to merge into");
    const [from, into] = await Promise.all([
      this.db.query.tags.findFirst({ where: and(eq(tags.id, id), eq(tags.organizationId, orgId)) }),
      this.db.query.tags.findFirst({ where: and(eq(tags.id, intoId), eq(tags.organizationId, orgId)) }),
    ]);
    if (!from || !into) throw new NotFoundException("Tag not found");
    await this.db.transaction(async (tx) => {
      const uses = await tx.select({ taskId: taskTags.taskId }).from(taskTags).where(eq(taskTags.tagId, id));
      if (uses.length) {
        await tx
          .insert(taskTags)
          .values(uses.map((u) => ({ taskId: u.taskId, tagId: intoId })))
          .onConflictDoNothing();
        await tx.delete(taskTags).where(eq(taskTags.tagId, id));
      }
      await tx.update(tags).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(tags.id, id));
    });
    return { merged: from.name, into: into.name };
  }

  /** Retire: the tag disappears from pickers and filters; existing task links stay for history. */
  async retireTag(orgId: string, id: string) {
    const [row] = await this.db
      .update(tags)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Tag not found");
    return { id, retired: true };
  }

  async members(orgId: string, includeDeactivated = false) {
    const rows = await this.db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: { user: true },
    });
    return rows
      .map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        /** True until they have signed in — the row was created by an invite. */
        pending: m.user.authSubject.startsWith("invite|"),
        /** Row 86 */
        deactivatedAt: m.deactivatedAt,
        endDate: m.endDate,
        accessEnded: accessEnded(m),
      }))
      // Pickers (assignees, mentions, approvers) shouldn't offer people who've left.
      .filter((m) => includeDeactivated || !m.accessEnded);
  }

  /* ---------------- Row 86: offboarding ---------------- */

  /** What's still on this person's plate - shown before deactivating so it can be handed over. */
  async openWork(orgId: string, userId: string) {
    const [openTasks, leading, running] = await Promise.all([
      this.db
        .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, listId: tasks.listId })
        .from(tasks)
        .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
        .where(and(eq(tasks.organizationId, orgId), eq(taskAssignees.userId, userId), isNull(tasks.completedAt), isNull(tasks.archivedAt)))
        .limit(200),
      this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), eq(projects.leadId, userId), isNull(projects.archivedAt)), columns: { id: true, name: true } }),
      this.db.query.timeEntries.findFirst({ where: and(eq(timeEntries.organizationId, orgId), eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)), columns: { id: true } }),
    ]);
    return { openTasks, leadOf: leading, timerRunning: Boolean(running) };
  }

  /**
   * Deactivate: block sign-in to this workspace (immediately, or from `endDate`),
   * stop any running timer, optionally hand open tasks to someone else. Their
   * messages, docs, time and history stay exactly where they are.
   */
  async deactivateMember(orgId: string, actorId: string, userId: string, opts: { endDate?: string | null; reassignToUserId?: string | null }) {
    const m = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)) });
    if (!m) throw new NotFoundException("Member not found");
    if (m.role === "owner") throw new BadRequestException("Transfer ownership before deactivating the owner");
    if (userId === actorId) throw new BadRequestException("You can't deactivate yourself");
    const endDate = opts.endDate ? new Date(opts.endDate) : null;
    const now = new Date();
    await this.db
      .update(memberships)
      .set({ endDate, deactivatedAt: endDate && endDate > now ? null : now, deactivatedById: actorId, updatedAt: now })
      .where(eq(memberships.id, m.id));
    // A running timer would otherwise tick forever.
    await this.db
      .update(timeEntries)
      .set({ endedAt: now, durationSeconds: sql`greatest(0, extract(epoch from (now() - ${timeEntries.startedAt})))::int`, updatedAt: now })
      .where(and(eq(timeEntries.organizationId, orgId), eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)));
    let reassigned = 0;
    if (opts.reassignToUserId) reassigned = await this.reassignOpenTasks(orgId, actorId, userId, opts.reassignToUserId);
    return { userId, endDate, deactivatedAt: endDate && endDate > now ? null : now, reassigned };
  }

  async reactivateMember(orgId: string, userId: string) {
    const [row] = await this.db
      .update(memberships)
      .set({ endDate: null, deactivatedAt: null, deactivatedById: null, updatedAt: new Date() })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Member not found");
    return { userId, reactivated: true };
  }

  /** Move every open task from one person to another (the new assignee is told). */
  async reassignOpenTasks(orgId: string, actorId: string, fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) throw new BadRequestException("Pick someone else");
    const [ok] = await this.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, toUserId)));
    if (!ok) throw new NotFoundException("That person isn't in this workspace");
    const { openTasks } = await this.openWork(orgId, fromUserId);
    for (const t of openTasks) {
      await this.db.delete(taskAssignees).where(and(eq(taskAssignees.taskId, t.id), eq(taskAssignees.userId, fromUserId)));
      await this.db.insert(taskAssignees).values({ taskId: t.id, userId: toUserId, organizationId: orgId }).onConflictDoNothing();
    }
    if (openTasks.length) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: toUserId,
        actorId,
        entityType: "task",
        entityId: openTasks[0]!.id,
        verb: "assigned",
        title: `${openTasks.length} task${openTasks.length === 1 ? "" : "s"} handed over to you`,
        body: openTasks.slice(0, 5).map((t) => t.title).join(", ") + (openTasks.length > 5 ? "…" : ""),
        data: { taskIds: openTasks.map((t) => t.id) },
      });
    }
    return openTasks.length;
  }

  /**
   * Invite by email. If the person already has an account we add the
   * membership; otherwise we create a placeholder user row keyed by email.
   * The first time they sign in with that email, auth's provisioning claims the
   * row (it matches on email before creating a new user), so everything
   * assigned or shared with them in the meantime is already theirs.
   */
  async invite(orgId: string, dto: { email: string; name?: string; role?: Role; invitedById?: string }) {
    const email = dto.email.trim().toLowerCase();
    if (!email.includes("@")) throw new BadRequestException("A valid email is required");
    const role: Role = dto.role ?? "member";
    if (role === "owner") throw new BadRequestException("Ownership is transferred, not granted by invite");

    let user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      const [created] = await this.db
        .insert(users)
        .values({
          authSubject: `invite|${email}`,
          email,
          name: dto.name?.trim() || email.split("@")[0]!,
        })
        .returning();
      user = created!;
    }

    await this.db
      .insert(memberships)
      .values({ organizationId: orgId, userId: user.id, role })
      .onConflictDoNothing();

    // Row 83: an invitation row with the e-mailed token; re-inviting refreshes it.
    const pending = user.authSubject.startsWith("invite|");
    const [inv] = await this.db
      .insert(invitations)
      .values({ organizationId: orgId, userId: user.id, email, role, token: randomBytes(24).toString("base64url"), invitedById: dto.invitedById ?? null, acceptedAt: pending ? null : new Date() })
      .returning();
    if (pending) await this.sendInviteEmail(orgId, inv!);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      pending,
      invitationId: inv!.id,
    };
  }

  /* ---------------- Row 83: invitations ---------------- */

  private async sendInviteEmail(orgId: string, inv: typeof invitations.$inferSelect) {
    const [org, inviter] = await Promise.all([
      this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } }),
      inv.invitedById ? this.db.query.users.findFirst({ where: eq(users.id, inv.invitedById), columns: { name: true } }) : Promise.resolve(null),
    ]);
    const roleWord = { owner: "owner", admin: "project manager", member: "team member", guest: "client guest" }[inv.role] ?? inv.role;
    await this.mailer.send({
      to: inv.email,
      subject: `${inviter?.name ?? "Someone"} invited you to ${org?.name ?? "a workspace"} on 4S PM Tool`,
      text: `${inviter?.name ?? "Someone"} added you to ${org?.name ?? "their workspace"} as a ${roleWord}.\n\nOpen the link below, sign in (or create your account) with this e-mail address, and you're in.`,
      link: `/?invite=${inv.token}`,
    });
    return { sent: this.mailer.configured };
  }

  /** Pending invites: not accepted, not revoked. */
  async listInvitations(orgId: string) {
    const rows = await this.db.query.invitations.findMany({
      where: and(eq(invitations.organizationId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
      with: { invitedBy: { columns: { id: true, name: true } } },
      orderBy: [desc(invitations.lastSentAt)],
    });
    return rows.map((i) => ({ id: i.id, email: i.email, role: i.role, userId: i.userId, invitedBy: i.invitedBy, createdAt: i.createdAt, lastSentAt: i.lastSentAt, emailConfigured: this.mailer.configured }));
  }

  async resendInvitation(orgId: string, id: string) {
    const inv = await this.db.query.invitations.findFirst({ where: and(eq(invitations.id, id), eq(invitations.organizationId, orgId)) });
    if (!inv) throw new NotFoundException("Invitation not found");
    if (inv.acceptedAt) throw new BadRequestException("Already accepted");
    if (inv.revokedAt) throw new BadRequestException("This invitation was revoked - invite them again instead");
    const [fresh] = await this.db.update(invitations).set({ lastSentAt: new Date() }).where(eq(invitations.id, id)).returning();
    const { sent } = await this.sendInviteEmail(orgId, fresh!);
    return { id, lastSentAt: fresh!.lastSentAt, sent };
  }

  /** Revoke: the link stops working and, if they never signed in, the placeholder membership goes too. */
  async revokeInvitation(orgId: string, id: string) {
    const inv = await this.db.query.invitations.findFirst({ where: and(eq(invitations.id, id), eq(invitations.organizationId, orgId)), with: { user: { columns: { authSubject: true } } } });
    if (!inv) throw new NotFoundException("Invitation not found");
    await this.db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, id));
    if (inv.user.authSubject.startsWith("invite|")) {
      await this.db.delete(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, inv.userId)));
    }
    return { id, revoked: true };
  }

  /** What the sign-in page shows when someone opens an invite link. Public; the token is the credential. */
  async invitationByToken(token: string) {
    const inv = await this.db.query.invitations.findFirst({
      where: eq(invitations.token, token),
      with: { organization: { columns: { name: true } }, invitedBy: { columns: { name: true } } },
    });
    if (!inv) throw new NotFoundException("Invitation not found");
    return {
      email: inv.email,
      role: inv.role,
      organization: inv.organization.name,
      invitedBy: inv.invitedBy?.name ?? null,
      status: inv.revokedAt ? "revoked" : inv.acceptedAt ? "accepted" : "pending",
    };
  }

  async setMemberRole(orgId: string, userId: string, role: Role) {
    if (role === "owner") throw new BadRequestException("Ownership is transferred, not granted");
    // Row 82: the owner's role only changes through a transfer - there is always exactly one owner.
    const current = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)) });
    if (!current) throw new NotFoundException("Member not found");
    if (current.role === "owner") throw new BadRequestException("Transfer ownership to someone else first");
    const [row] = await this.db
      .update(memberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Member not found");
    return { userId, role };
  }

  /**
   * Row 82: hand the workspace to another member. They become the single
   * owner; the previous owner steps down to project manager (admin).
   */
  async transferOwnership(orgId: string, fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) throw new BadRequestException("You already own this workspace");
    const target = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, toUserId)),
      with: { user: { columns: { authSubject: true, name: true } } },
    });
    if (!target) throw new NotFoundException("That person isn't a member of this workspace");
    if (target.user.authSubject.startsWith("invite|")) throw new BadRequestException("They need to sign in at least once before they can own the workspace");
    await this.db.transaction(async (tx) => {
      await tx.update(memberships).set({ role: "admin", updatedAt: new Date() }).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, fromUserId)));
      await tx.update(memberships).set({ role: "owner", updatedAt: new Date() }).where(eq(memberships.id, target.id));
      await tx.update(organizations).set({ ownerId: toUserId, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    });
    return { ownerId: toUserId, previousOwnerRole: "admin" as Role };
  }

  async removeMember(orgId: string, userId: string) {
    const m = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)),
    });
    if (!m) throw new NotFoundException("Member not found");
    if (m.role === "owner") throw new BadRequestException("The owner cannot be removed");
    await this.db.delete(memberships).where(eq(memberships.id, m.id));
    return { userId, removed: true };
  }

  /* ---- Space overview ---- */

  /**
   * Everything the overview page shows, in a handful of grouped queries:
   * folders → lists with task counts, status workload for the pie, the project
   * wrapping the space (if any) with its docs, and bookmarks.
   */
  async spaceOverview(orgId: string, spaceId: string) {
    const space = await this.assertSpace(orgId, spaceId);

    const [folderRows, listRows, taskCounts, workload, project, bookmarkRows] = await Promise.all([
      this.db.query.folders.findMany({
        where: and(eq(folders.organizationId, orgId), eq(folders.spaceId, spaceId), isNull(folders.archivedAt)),
        orderBy: (f) => [asc(f.position)],
      }),
      this.db.query.lists.findMany({
        where: and(eq(lists.organizationId, orgId), eq(lists.spaceId, spaceId), isNull(lists.archivedAt)),
        orderBy: (l) => [asc(l.position)],
      }),
      this.db
        .select({
          listId: tasks.listId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
        })
        .from(tasks)
        .innerJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(and(eq(tasks.organizationId, orgId), eq(lists.spaceId, spaceId), isNull(tasks.archivedAt)))
        .groupBy(tasks.listId),
      this.db
        .select({
          statusId: tasks.statusId,
          name: statuses.name,
          color: statuses.color,
          count: sql<number>`count(*)::int`,
        })
        .from(tasks)
        .innerJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(and(eq(tasks.organizationId, orgId), eq(lists.spaceId, spaceId), isNull(tasks.archivedAt)))
        .groupBy(tasks.statusId, statuses.name, statuses.color),
      this.db.query.projects.findFirst({
        where: and(eq(projects.organizationId, orgId), eq(projects.spaceId, spaceId), isNull(projects.archivedAt)),
      }),
      this.db.query.bookmarks.findMany({
        where: and(eq(bookmarks.organizationId, orgId), eq(bookmarks.spaceId, spaceId)),
        orderBy: (b) => [asc(b.createdAt)],
      }),
    ]);

    const docs = project
      ? await this.db.query.documents.findMany({
          where: and(eq(documents.organizationId, orgId), eq(documents.projectId, project.id), isNull(documents.archivedAt)),
          orderBy: (d) => [asc(d.title)],
        })
      : [];

    const countByList = new Map(taskCounts.map((c) => [c.listId, c]));
    const shapeList = (l: typeof listRows[number]) => ({
      id: l.id,
      name: l.name,
      folderId: l.folderId,
      tasksTotal: countByList.get(l.id)?.total ?? 0,
      tasksDone: countByList.get(l.id)?.done ?? 0,
    });

    return {
      space: { id: space.id, name: space.name, color: space.color },
      project: project ? { id: project.id, name: project.name } : null,
      folders: folderRows.map((f) => ({
        id: f.id,
        name: f.name,
        lists: listRows.filter((l) => l.folderId === f.id).map(shapeList),
      })),
      lists: listRows.filter((l) => !l.folderId).map(shapeList),
      workload: workload.map((w) => ({
        statusId: w.statusId,
        name: w.name ?? "No status",
        color: w.color ?? "#cbd5e1",
        count: w.count,
      })),
      docs: docs.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt })),
      bookmarks: bookmarkRows.map((b) => ({ id: b.id, title: b.title, url: b.url })),
    };
  }

  async createFolder(orgId: string, spaceId: string, name: string) {
    await this.assertSpace(orgId, spaceId);
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${folders.position}), 0)` })
      .from(folders)
      .where(eq(folders.spaceId, spaceId));
    const [row] = await this.db
      .insert(folders)
      .values({ organizationId: orgId, spaceId, name, position: Number(max?.m ?? 0) + 1 })
      .returning();
    return { id: row!.id, name: row!.name, spaceId };
  }

  /** Lists can be created straight into a folder from the overview. */
  async createListInFolder(orgId: string, spaceId: string, folderId: string, name: string) {
    const folder = await this.db.query.folders.findFirst({
      where: and(eq(folders.id, folderId), eq(folders.spaceId, spaceId), eq(folders.organizationId, orgId)),
    });
    if (!folder) throw new NotFoundException("Folder not found");
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${lists.position}), 0)` })
      .from(lists)
      .where(eq(lists.folderId, folderId));
    const [list] = await this.db
      .insert(lists)
      .values({ organizationId: orgId, spaceId, folderId, name, position: Number(max?.m ?? 0) + 1 })
      .returning();
    return { id: list!.id, name: list!.name, spaceId };
  }

  async addBookmark(orgId: string, userId: string, spaceId: string, dto: { title: string; url: string }) {
    await this.assertSpace(orgId, spaceId);
    const url = /^https?:\/\//i.test(dto.url) ? dto.url : `https://${dto.url}`;
    const [row] = await this.db
      .insert(bookmarks)
      .values({ organizationId: orgId, spaceId, title: dto.title.trim(), url, createdById: userId })
      .returning();
    return { id: row!.id, title: row!.title, url: row!.url };
  }

  async removeBookmark(orgId: string, spaceId: string, id: string) {
    await this.db
      .delete(bookmarks)
      .where(and(eq(bookmarks.id, id), eq(bookmarks.spaceId, spaceId), eq(bookmarks.organizationId, orgId)));
    return { id, deleted: true };
  }

  private async assertSpace(orgId: string, spaceId: string) {
    const s = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.id, spaceId), eq(spaces.organizationId, orgId)),
    });
    if (!s) throw new NotFoundException("Space not found");
    return s;
  }
}
