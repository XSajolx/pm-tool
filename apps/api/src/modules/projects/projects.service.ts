import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  companies,
  lists,
  memberships,
  projects,
  spaces,
  statuses,
  tasks,
  timeEntries,
} from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { StagesService } from "./stages.service.js";

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
  loggedSeconds: number;
  billableSeconds: number;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly stages: StagesService,
  ) {}

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
      out.set(r.id, { tasksTotal: 0, tasksDone: 0, loggedSeconds: 0, billableSeconds: 0 });
    }
    if (!rows.length) return out;

    const spaceIds = rows.map((r) => r.spaceId).filter(Boolean) as string[];
    if (spaceIds.length) {
      const taskRows = await this.db
        .select({
          spaceId: lists.spaceId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
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
        }
      }
    }

    const timeRows = await this.db
      .select({
        projectId: timeEntries.projectId,
        logged: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)::int`,
        billable: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.billable}), 0)::int`,
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
      }
    }
    return out;
  }
}
