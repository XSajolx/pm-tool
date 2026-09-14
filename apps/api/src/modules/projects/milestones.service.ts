import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { milestones, projects, statuses, tasks, users } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { ChatEventsService } from "../chat/chat-events.service.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";

export interface MilestoneWrite {
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  /** Set by hand: reaching a milestone is a deliberate statement, not a side effect of ticking tasks. */
  reachedAt?: string | null;
  clientVisible?: boolean;
}

/**
 * Milestones (row 32): named checkpoints with a target date that tasks link
 * to. "Reached" is set explicitly by the PM; task progress is shown alongside
 * but never flips the milestone on its own.
 */
@Injectable()
export class MilestonesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly chatEvents: ChatEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Row 75: inbox cards decide milestone sign-offs through here. */
  onModuleInit() {
    this.notifications.registerApproval("milestone", (d) => this.decideSignoff(d.orgId, { userId: d.userId, role: d.role }, d.entityId, d.approve, d.note));
  }

  /* ---------------- Row 75: sign-off ---------------- */

  /** Ask the project lead (or a named approver) to sign the milestone off. Lands as an inbox card. */
  async requestSignoff(orgId: string, userId: string, id: string, approverId?: string) {
    const m = await this.db.query.milestones.findFirst({
      where: and(eq(milestones.id, id), eq(milestones.organizationId, orgId), isNull(milestones.archivedAt)),
      with: { project: { columns: { id: true, name: true, leadId: true } } },
    });
    if (!m) throw new NotFoundException("Milestone not found");
    if (m.reachedAt) throw new BadRequestException("Already reached");
    if (m.signoffStatus === "pending") throw new BadRequestException("Sign-off already requested");
    const approver = approverId ?? m.project.leadId;
    if (!approver) throw new BadRequestException("Pick an approver - this project has no lead");
    const now = new Date();
    await this.db
      .update(milestones)
      .set({ signoffStatus: "pending", signoffRequestedById: userId, signoffRequestedAt: now, signoffApproverId: approver, signoffNote: null, updatedAt: now })
      .where(eq(milestones.id, id));
    const [requester] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    await this.notifications.notifyDirect({
      orgId,
      receiverId: approver,
      actorId: userId,
      entityType: "milestone",
      entityId: id,
      verb: "milestone_signoff_requested",
      title: `Sign-off requested: ${m.name}`,
      body: `${m.project.name}${m.targetDate ? ` - target ${m.targetDate.toLocaleDateString()}` : ""}${requester ? ` - asked by ${requester.name}` : ""}`,
      data: { projectId: m.projectId, milestoneId: id, approval: pendingApproval("milestone") },
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "milestone", entityId: id, action: "signoff_requested" });
    return this.one(orgId, id);
  }

  /** Approving marks the milestone reached (with the usual activity + chat announcement); rejecting leaves a note. */
  async decideSignoff(orgId: string, actor: { userId: string; role: string }, id: string, approve: boolean, note?: string) {
    const m = await this.db.query.milestones.findFirst({ where: and(eq(milestones.id, id), eq(milestones.organizationId, orgId)) });
    if (!m) throw new NotFoundException("Milestone not found");
    if (m.signoffStatus !== "pending") throw new BadRequestException("This milestone isn't waiting for sign-off");
    const admin = actor.role === "owner" || actor.role === "admin";
    if (m.signoffApproverId !== actor.userId && !admin) throw new ForbiddenException("Only the named approver can sign this off");
    const now = new Date();
    await this.db
      .update(milestones)
      .set({ signoffStatus: approve ? "approved" : "rejected", signoffNote: note?.trim() || null, updatedAt: now })
      .where(eq(milestones.id, id));
    if (approve) await this.update(orgId, actor.userId, id, { reachedAt: now.toISOString() });
    await this.notifications.resolveApproval("milestone", id, approve ? "approved" : "rejected", note, actor.userId);
    if (m.signoffRequestedById && m.signoffRequestedById !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: m.signoffRequestedById,
        actorId: actor.userId,
        entityType: "milestone",
        entityId: id,
        verb: approve ? "milestone_approved" : "milestone_rejected",
        title: `${approve ? "Signed off" : "Sign-off declined"}: ${m.name}`,
        body: note?.trim() || (approve ? "Milestone reached" : "Needs more work"),
        data: { projectId: m.projectId, milestoneId: id },
      });
    }
    return this.one(orgId, id);
  }

  private async one(orgId: string, id: string) {
    const row = await this.db.query.milestones.findFirst({ where: and(eq(milestones.id, id), eq(milestones.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Milestone not found");
    const progress = await this.progressFor([id]);
    return { ...row, progress: progress.get(id) ?? { total: 0, done: 0 } };
  }

  async listForProject(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    const rows = await this.db.query.milestones.findMany({
      where: and(eq(milestones.projectId, projectId), eq(milestones.organizationId, orgId), isNull(milestones.archivedAt)),
      orderBy: [asc(milestones.targetDate), asc(milestones.createdAt)],
    });
    const progress = await this.progressFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, progress: progress.get(r.id) ?? { total: 0, done: 0 } }));
  }

  /** Milestones of the project that owns `spaceId` (task pickers). */
  async listForSpace(orgId: string, spaceId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.spaceId, spaceId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) return [];
    return this.listForProject(orgId, project.id);
  }

  async create(orgId: string, userId: string, projectId: string, dto: MilestoneWrite & { name: string }) {
    await this.assertProject(orgId, projectId);
    const [row] = await this.db
      .insert(milestones)
      .values({
        organizationId: orgId,
        projectId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
        reachedAt: dto.reachedAt ? new Date(dto.reachedAt) : null,
        clientVisible: dto.clientVisible ?? false,
        createdById: userId,
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "milestone", entityId: row!.id, action: "created" });
    return { ...row!, progress: { total: 0, done: 0 } };
  }

  async update(orgId: string, userId: string, id: string, dto: MilestoneWrite) {
    const before = await this.db.query.milestones.findFirst({
      where: and(eq(milestones.id, id), eq(milestones.organizationId, orgId)),
    });
    if (!before) throw new NotFoundException("Milestone not found");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.targetDate !== undefined) patch.targetDate = dto.targetDate ? new Date(dto.targetDate) : null;
    if (dto.reachedAt !== undefined) patch.reachedAt = dto.reachedAt ? new Date(dto.reachedAt) : null;
    if (dto.clientVisible !== undefined) patch.clientVisible = dto.clientVisible;
    const [row] = await this.db.update(milestones).set(patch).where(eq(milestones.id, id)).returning();

    if (dto.reachedAt !== undefined && Boolean(dto.reachedAt) !== Boolean(before.reachedAt)) {
      await this.activity.record({
        orgId,
        actorId: userId,
        entityType: "milestone",
        entityId: id,
        action: dto.reachedAt ? "reached" : "unreached",
        changes: [{ field: "reachedAt", from: before.reachedAt?.toISOString() ?? null, to: dto.reachedAt ?? null }],
      });
      // Row 50: reaching a milestone is announced in the project channel.
      if (dto.reachedAt) {
        await this.chatEvents.postProjectEvent(orgId, before.projectId, userId, {
          type: "milestone_reached",
          text: `reached the “${row!.name}” milestone 🎯`,
          link: `/projects/${before.projectId}`,
          entityId: id,
        });
      }
    }
    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      { name: dto.name, targetDate: dto.targetDate, clientVisible: dto.clientVisible } as Record<string, unknown>,
      ["name", "targetDate", "clientVisible"],
    );
    if (changes.length) {
      await this.activity.record({ orgId, actorId: userId, entityType: "milestone", entityId: id, action: "updated", changes });
    }
    const progress = await this.progressFor([id]);
    return { ...row!, progress: progress.get(id) ?? { total: 0, done: 0 } };
  }

  /** Soft delete; linked tasks keep working, they just lose the milestone link. */
  async remove(orgId: string, userId: string, id: string) {
    const [row] = await this.db
      .update(milestones)
      .set({ archivedAt: new Date() })
      .where(and(eq(milestones.id, id), eq(milestones.organizationId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Milestone not found");
    await this.db.update(tasks).set({ milestoneId: null }).where(eq(tasks.milestoneId, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "milestone", entityId: id, action: "deleted" });
    return { id, deleted: true };
  }

  activityFor(orgId: string, id: string) {
    return this.activity.listFor(orgId, "milestone", id);
  }

  private async assertProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");
  }

  private async progressFor(ids: string[]) {
    const out = new Map<string, { total: number; done: number }>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({
        milestoneId: tasks.milestoneId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${statuses.category} = 'done')::int`,
      })
      .from(tasks)
      .leftJoin(statuses, eq(statuses.id, tasks.statusId))
      .where(and(inArray(tasks.milestoneId, ids), isNull(tasks.archivedAt)))
      .groupBy(tasks.milestoneId);
    for (const r of rows) if (r.milestoneId) out.set(r.milestoneId, { total: r.total, done: r.done });
    return out;
  }
}
