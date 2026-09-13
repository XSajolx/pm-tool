import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  bookmarks,
  documents,
  folders,
  lists,
  memberships,
  projects,
  spaces,
  statuses,
  tags,
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
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

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

  /* ---- Tags (labels) live on the space, like statuses ---- */

  async tagsForSpace(orgId: string, spaceId: string) {
    return this.db.query.tags.findMany({
      where: and(eq(tags.organizationId, orgId), eq(tags.spaceId, spaceId), isNull(tags.archivedAt)),
      orderBy: (t) => [asc(t.name)],
    });
  }

  async createTag(orgId: string, spaceId: string, dto: { name: string; color?: string }) {
    await this.assertSpace(orgId, spaceId);
    const [row] = await this.db
      .insert(tags)
      .values({ organizationId: orgId, spaceId, name: dto.name.trim(), color: dto.color ?? "#6b7280" })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // Same name already exists on this space — return it rather than 409ing.
    const existing = await this.db.query.tags.findFirst({
      where: and(eq(tags.spaceId, spaceId), eq(tags.name, dto.name.trim())),
    });
    return existing!;
  }

  /** Org members for assignee pickers / avatars. */
  async members(orgId: string) {
    const rows = await this.db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: { user: true },
    });
    return rows.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      /** True until they have signed in — the row was created by an invite. */
      pending: m.user.authSubject.startsWith("invite|"),
    }));
  }

  /**
   * Invite by email. If the person already has an account we add the
   * membership; otherwise we create a placeholder user row keyed by email.
   * The first time they sign in with that email, auth's provisioning claims the
   * row (it matches on email before creating a new user), so everything
   * assigned or shared with them in the meantime is already theirs.
   */
  async invite(orgId: string, dto: { email: string; name?: string; role?: Role }) {
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

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      pending: user.authSubject.startsWith("invite|"),
    };
  }

  async setMemberRole(orgId: string, userId: string, role: Role) {
    if (role === "owner") throw new BadRequestException("Ownership is transferred, not granted");
    const [row] = await this.db
      .update(memberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException("Member not found");
    return { userId, role };
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
