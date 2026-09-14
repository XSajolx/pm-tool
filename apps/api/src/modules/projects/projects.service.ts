import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  channels,
  companies,
  lists,
  memberships,
  milestones,
  projectMembers,
  projectStages,
  projects,
  spaces,
  statuses,
  tasks,
  timeEntries,
  users,
} from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { startOfWeek } from "../time/time.service.js";
import { StagesService } from "./stages.service.js";
import { ChatService } from "../chat/chat.service.js";
import { DocTemplatesService } from "../documents/doc-templates.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

export interface ProjectDto {
  name: string;
  clientName?: string | null;
  /** CRM company; when set, clientName mirrors the company name. */
  companyId?: string | null;
  /** Project lead (a member of the org). */
  leadId?: string | null;
  description?: string;
  color?: string;
  status?: "active" | "on_hold" | "completed" | "archived";
  startDate?: string | null;
  endDate?: string | null;
  budgetHours?: number;
  budgetAmount?: number;
  hourlyRate?: number;
  currency?: string;
  /** Wrap an existing space instead of creating one. */
  spaceId?: string;
}

/** The statuses every new project space starts with — same set the seed uses. */
const DEFAULT_STATUSES = [
  { name: "To Do", category: "not_started", color: "#94a3b8", position: 1 },
  { name: "In Progress", category: "active", color: "#3b82f6", position: 2 },
  { name: "In Review", category: "active", color: "#f59e0b", position: 3 },
  { name: "Done", category: "done", color: "#22c55e", position: 4 },
] as const;

export interface ProjectStats {
  tasksTotal: number;
  tasksDone: number;
  /** Row 99: dashboard roll-up. */
  tasksOpen: number;
  tasksOverdue: number;
  loggedSeconds: number;
  billableSeconds: number;
  /** Seconds logged since Monday 00:00 UTC. */
  weekSeconds: number;
  nextMilestone: { id: string; name: string; targetDate: string | null; overdue: boolean } | null;
  /** The project's chat channel, for the dashboard link. */
  channelId: string | null;
  /** Row 100: the active stage, else the first not-started one; null when every stage is done. */
  currentStage: { id: string; name: string; status: "not_started" | "active" | "completed"; index: number; count: number; progressPct: number } | null;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly stages: StagesService,
    private readonly chat: ChatService,
    private readonly docTemplates: DocTemplatesService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------------- Row 39: project team + project channel ---------------- */

  /** The team = explicit members ∪ lead ∪ creator. */
  private async teamIds(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true, name: true, leadId: true, createdById: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const rows = await this.db.query.projectMembers.findMany({ where: eq(projectMembers.projectId, projectId), columns: { userId: true, role: true } });
    const ids = new Set(rows.map((r) => r.userId));
    if (project.leadId) ids.add(project.leadId);
    if (project.createdById) ids.add(project.createdById);
    const roles = new Map(rows.map((r) => [r.userId, r.role]));
    return { project, ids: [...ids], roles };
  }

  async members(orgId: string, projectId: string) {
    const { project, ids, roles } = await this.teamIds(orgId, projectId);
    if (!ids.length) return [];
    const rows = await this.db.query.users.findMany({
      where: inArray(users.id, ids),
      columns: { id: true, name: true, email: true, avatarUrl: true },
    });
    const order = { lead: 0, contributor: 1, viewer: 2 } as const;
    return rows
      .map((u) => {
        const isLead = u.id === project.leadId;
        const isCreator = u.id === project.createdById;
        // Row 85: the lead and creator are always leads; everyone else has the role on their row.
        const role = (isLead || isCreator ? "lead" : (roles.get(u.id) as "lead" | "contributor" | "viewer" | undefined) ?? "contributor") as "lead" | "contributor" | "viewer";
        return { ...u, isLead, isCreator, role };
      })
      .sort((a, b) => Number(b.isLead) - Number(a.isLead) || order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  }

  /** Row 85: give someone on the project a role. The lead / creator are fixed as leads. */
  async setMemberRole(orgId: string, actorId: string, projectId: string, userId: string, role: "lead" | "contributor" | "viewer") {
    const { project } = await this.teamIds(orgId, projectId);
    if ((userId === project.leadId || userId === project.createdById) && role !== "lead") throw new BadRequestException("The project lead and creator are always leads - change the project lead first");
    const [ok] = await this.orgUserIds(orgId, [userId]);
    if (!ok) throw new NotFoundException("That person isn't in this workspace");
    await this.db
      .insert(projectMembers)
      .values({ projectId, userId, organizationId: orgId, role })
      .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role } });
    await this.activity.record({ orgId, actorId, entityType: "list", entityId: projectId, action: "project_updated", changes: [{ field: "memberRole", from: userId, to: role }] });
    await this.syncChannel(orgId, projectId);
    return this.members(orgId, projectId);
  }

  private async orgUserIds(orgId: string, userIds: string[]) {
    const uniq = [...new Set(userIds)];
    if (!uniq.length) return [];
    const rows = await this.db.query.memberships.findMany({
      where: and(eq(memberships.organizationId, orgId), inArray(memberships.userId, uniq)),
      columns: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async addMembers(orgId: string, actorId: string, projectId: string, userIds: string[]) {
    await this.teamIds(orgId, projectId);
    const ids = await this.orgUserIds(orgId, userIds);
    if (ids.length) {
      await this.db
        .insert(projectMembers)
        .values(ids.map((userId) => ({ projectId, userId, organizationId: orgId })))
        .onConflictDoNothing();
      await this.activity.record({
        orgId,
        actorId,
        entityType: "list",
        entityId: projectId,
        action: "project_updated",
        changes: ids.map((id) => ({ field: "member", from: null, to: id })),
      });
    }
    await this.syncChannel(orgId, projectId);
    return this.members(orgId, projectId);
  }

  async removeMember(orgId: string, actorId: string, projectId: string, userId: string) {
    const { project } = await this.teamIds(orgId, projectId);
    if (userId === project.leadId) throw new BadRequestException("Change the project lead before removing them");
    if (userId === project.createdById) throw new BadRequestException("The project creator stays on the team");
    await this.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    await this.activity.record({
      orgId,
      actorId,
      entityType: "list",
      entityId: projectId,
      action: "project_updated",
      changes: [{ field: "member", from: userId, to: null }],
    });
    await this.syncChannel(orgId, projectId);
    return this.members(orgId, projectId);
  }

  /** Make the project channel's members match the team (creating the channel if needed). */
  async syncChannel(orgId: string, projectId: string) {
    const { project, ids } = await this.teamIds(orgId, projectId);
    return this.chat.ensureProjectChannel(orgId, project, ids);
  }

  /**
   * Assigning someone a task in a project puts them on the team — and so in
   * the project channel. No-op for lists that aren't part of a project.
   */
  async ensureMembersForList(orgId: string, listId: string, userIds: string[]) {
    const list = await this.db.query.lists.findFirst({ where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)), columns: { spaceId: true } });
    if (!list) return;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.spaceId, list.spaceId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) return;
    const ids = await this.orgUserIds(orgId, userIds);
    if (!ids.length) return;
    const before = await this.db.query.projectMembers.findMany({ where: eq(projectMembers.projectId, project.id), columns: { userId: true } });
    const have = new Set(before.map((b) => b.userId));
    if (ids.every((id) => have.has(id))) return;
    await this.db
      .insert(projectMembers)
      .values(ids.map((userId) => ({ projectId: project.id, userId, organizationId: orgId })))
      .onConflictDoNothing();
    await this.syncChannel(orgId, project.id);
  }

  async list(orgId: string, includeArchived = false) {
    const rows = await this.db.query.projects.findMany({
      where: and(
        eq(projects.organizationId, orgId),
        ...(includeArchived ? [] : [isNull(projects.archivedAt)]),
      ),
      with: { company: { columns: { id: true, name: true } }, lead: { columns: { id: true, name: true, avatarUrl: true } } },
      orderBy: desc(projects.createdAt),
    });

    const stats = await this.statsFor(orgId, rows);
    return rows.map((p) => ({ ...p, stats: stats.get(p.id)! }));
  }

  async get(orgId: string, id: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, id), eq(projects.organizationId, orgId)),
      with: {
        space: { with: { lists: true } },
        company: { columns: { id: true, name: true } },
        lead: { columns: { id: true, name: true, avatarUrl: true } },
      },
    });
    if (!project) throw new NotFoundException("Project not found");
    const stats = await this.statsFor(orgId, [project]);
    return { ...project, stats: stats.get(project.id)! };
  }

  /** Resolve company/lead references to this org; returns the client display name to store. */
  private async resolveLinks(orgId: string, dto: Partial<ProjectDto>) {
    let clientName = dto.clientName;
    if (dto.companyId) {
      const company = await this.db.query.companies.findFirst({
        where: and(eq(companies.id, dto.companyId), eq(companies.organizationId, orgId)),
      });
      if (!company) throw new BadRequestException("Company not found in this organization");
      clientName = company.name;
    }
    if (dto.leadId) {
      const member = await this.db.query.memberships.findFirst({
        where: and(eq(memberships.userId, dto.leadId), eq(memberships.organizationId, orgId)),
      });
      if (!member) throw new BadRequestException("Project lead must be a member of this organization");
    }
    return clientName;
  }

  /**
   * Creating a project without a space also creates the space, its default
   * statuses and a first list — so the project is usable the moment it exists
   * rather than being an empty shell that needs three more setup steps.
   */
  async create(orgId: string, userId: string, dto: ProjectDto) {
    const clientName = await this.resolveLinks(orgId, dto);
    let spaceId = dto.spaceId ?? null;
    if (spaceId) {
      const space = await this.db.query.spaces.findFirst({
        where: and(eq(spaces.id, spaceId), eq(spaces.organizationId, orgId)),
      });
      if (!space) throw new BadRequestException("Space not found in this organization");
      const taken = await this.db.query.projects.findFirst({
        where: eq(projects.spaceId, spaceId),
      });
      if (taken) throw new BadRequestException("That space already belongs to a project");
    }

    return this.db.transaction(async (tx) => {
      if (!spaceId) {
        const [space] = await tx
          .insert(spaces)
          .values({
            organizationId: orgId,
            name: dto.name,
            color: dto.color ?? "#6366f1",
            position: Date.now(),
          })
          .returning();
        spaceId = space!.id;

        await tx.insert(statuses).values(
          DEFAULT_STATUSES.map((s) => ({ ...s, organizationId: orgId, spaceId: spaceId! })),
        );
        await tx.insert(lists).values({
          organizationId: orgId,
          spaceId,
          name: "Tasks",
          position: 1,
        });
      }

      const [project] = await tx
        .insert(projects)
        .values({
          organizationId: orgId,
          spaceId,
          name: dto.name,
          clientName: clientName ?? null,
          companyId: dto.companyId ?? null,
          leadId: dto.leadId ?? null,
          description: dto.description,
          color: dto.color ?? "#6366f1",
          status: dto.status ?? "active",
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          budgetHours: dto.budgetHours,
          budgetAmount: dto.budgetAmount,
          hourlyRate: dto.hourlyRate,
          currency: dto.currency ?? "USD",
          createdById: userId,
        })
        .returning();

      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "list",
        entityId: project!.id,
        action: "project_created",
      });
      return project!;
    }).then(async (project) => {
      // New projects start with the org's default stage sequence (Settings → Stage templates).
      const names = await this.stages.defaultStageNames(orgId);
      if (names.length) await this.stages.appendStages(orgId, userId, project.id, names);
      // Row 77: creator and lead follow the project from day one.
      await this.notifications.follow(orgId, userId, "project", project.id, "created");
      if (project.leadId) await this.notifications.follow(orgId, project.leadId, "project", project.id, "assigned");
      // Row 39: creator + lead form the first team; the project channel follows.
      await this.db
        .insert(projectMembers)
        .values([userId, ...(project.leadId ? [project.leadId] : [])].map((id) => ({ projectId: project.id, userId: id, organizationId: orgId })))
        .onConflictDoNothing();
      await this.syncChannel(orgId, project.id);
      // Row 68: every project starts with the same set of docs.
      await this.docTemplates.applyKit(orgId, userId, project.id);
      return project;
    });
  }

  async update(orgId: string, userId: string, id: string, dto: Partial<ProjectDto>) {
    const before = await this.get(orgId, id);
    const clientName = await this.resolveLinks(orgId, dto);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.companyId !== undefined) patch.companyId = dto.companyId;
    if (dto.leadId !== undefined) patch.leadId = dto.leadId;
    if (dto.companyId) patch.clientName = clientName;
    else if (dto.clientName !== undefined) patch.clientName = dto.clientName;
    for (const key of [
      "name",
      "description",
      "color",
      "status",
      "budgetHours",
      "budgetAmount",
      "hourlyRate",
      "currency",
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    if (dto.startDate !== undefined) patch.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.endDate !== undefined) patch.endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (dto.status === "archived") patch.archivedAt = new Date();
    if (dto.status && dto.status !== "archived" && before.archivedAt) patch.archivedAt = null;

    const [row] = await this.db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, id), eq(projects.organizationId, orgId)))
      .returning();

    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      dto as unknown as Record<string, unknown>,
      ["name", "status", "budgetHours", "budgetAmount", "hourlyRate", "clientName", "leadId", "companyId", "startDate", "endDate"],
    );
    if (changes.length) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "list",
        entityId: id,
        action: "project_updated",
        changes,
      });
    }
    // A renamed project renames its channel; a new lead joins it.
    if (dto.name !== undefined || dto.leadId !== undefined) await this.syncChannel(orgId, id);
    return row!;
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.update(orgId, userId, id, { status: "archived" });
    return { id, archived: true };
  }

  /**
   * Task and time roll-ups for a set of projects in two grouped queries. Task
   * "done" is decided by status category, so custom names still count.
   */
  private async statsFor(orgId: string, rows: { id: string; spaceId: string | null }[]) {
    const out = new Map<string, ProjectStats>();
    for (const r of rows) {
      out.set(r.id, { tasksTotal: 0, tasksDone: 0, tasksOpen: 0, tasksOverdue: 0, loggedSeconds: 0, billableSeconds: 0, weekSeconds: 0, nextMilestone: null, channelId: null, currentStage: null });
    }
    if (!rows.length) return out;

    const spaceIds = rows.map((r) => r.spaceId).filter(Boolean) as string[];
    if (spaceIds.length) {
      const taskRows = await this.db
        .select({
          spaceId: lists.spaceId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
          overdue: sql<number>`count(*) filter (where ${statuses.category} is distinct from 'done' and ${tasks.dueDate} < now())::int`,
        })
        .from(tasks)
        .innerJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(
          and(
            eq(tasks.organizationId, orgId),
            isNull(tasks.archivedAt),
            inArray(lists.spaceId, spaceIds),
          ),
        )
        .groupBy(lists.spaceId);
      const bySpace = new Map(taskRows.map((t) => [t.spaceId, t]));
      for (const r of rows) {
        const t = r.spaceId ? bySpace.get(r.spaceId) : undefined;
        if (t) {
          out.get(r.id)!.tasksTotal = t.total;
          out.get(r.id)!.tasksDone = t.done;
          out.get(r.id)!.tasksOpen = t.total - t.done;
          out.get(r.id)!.tasksOverdue = t.overdue;
        }
      }
    }

    const weekStart = startOfWeek(new Date()).toISOString();
    const timeRows = await this.db
      .select({
        projectId: timeEntries.projectId,
        logged: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
        billable: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.billable}), 0)::int`,
        week: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.startedAt} >= ${weekStart}::timestamptz), 0)::int`,
      })
      .from(timeEntries)
      .where(
        inArray(
          timeEntries.projectId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(timeEntries.projectId);
    for (const t of timeRows) {
      const s = out.get(t.projectId);
      if (s) {
        s.loggedSeconds = t.logged;
        s.billableSeconds = t.billable;
        s.weekSeconds = t.week;
      }
    }

    // Row 99: next unreached milestone (earliest target, undated last) + the project channel.
    const ids = rows.map((r) => r.id);
    const ms = await this.db
      .select({ id: milestones.id, projectId: milestones.projectId, name: milestones.name, targetDate: milestones.targetDate })
      .from(milestones)
      .where(and(inArray(milestones.projectId, ids), isNull(milestones.reachedAt)))
      .orderBy(sql`${milestones.targetDate} asc nulls last`, milestones.createdAt);
    for (const m of ms) {
      const s = out.get(m.projectId);
      if (s && !s.nextMilestone) {
        s.nextMilestone = {
          id: m.id,
          name: m.name,
          targetDate: m.targetDate ? m.targetDate.toISOString() : null,
          overdue: Boolean(m.targetDate && m.targetDate.getTime() < Date.now()),
        };
      }
    }
    const chans = await this.db
      .select({ id: channels.id, projectId: channels.projectId })
      .from(channels)
      .where(and(inArray(channels.projectId, ids), isNull(channels.archivedAt)));
    for (const c of chans) {
      const s = c.projectId ? out.get(c.projectId) : undefined;
      if (s && !s.channelId) s.channelId = c.id;
    }

    // Row 100: current stage per project (active first, else the first one not started).
    const stageRows = await this.db
      .select({ id: projectStages.id, projectId: projectStages.projectId, name: projectStages.name, status: projectStages.status, progressPct: projectStages.progressPct })
      .from(projectStages)
      .where(and(inArray(projectStages.projectId, ids), isNull(projectStages.archivedAt)))
      .orderBy(projectStages.projectId, projectStages.position);
    const byProject = new Map<string, typeof stageRows>();
    for (const st of stageRows) byProject.set(st.projectId, [...(byProject.get(st.projectId) ?? []), st]);
    for (const [pid, list] of byProject) {
      const s = out.get(pid);
      if (!s) continue;
      const idx = list.findIndex((st) => st.status === "active");
      const pick = idx >= 0 ? idx : list.findIndex((st) => st.status === "not_started");
      const cur = pick >= 0 ? list[pick] : undefined;
      if (cur) s.currentStage = { id: cur.id, name: cur.name, status: cur.status, index: pick + 1, count: list.length, progressPct: cur.progressPct };
    }
    return out;
  }
}
