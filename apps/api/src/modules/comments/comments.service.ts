import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { comments, memberships, tasks, users } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

export interface CreateCommentDto {
  body: string;
  /** Explicit mentions from the composer. Names in the body are matched too. */
  mentionedUserIds?: string[];
  /** Hand the comment to someone as an action item. */
  assigneeId?: string;
  parentCommentId?: string;
}

@Injectable()
export class CommentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Posting a comment does three social things beyond storing text: it
   * subscribes the author (you'll want the replies), it notifies followers, and
   * it delivers direct Primary notifications to anyone @mentioned or assigned.
   *
   * Mentions are taken from the composer's explicit list AND recovered from
   * `@Name` in the body — so a comment typed anywhere still lands, but only for
   * names that are actually members of this org. Nothing here can notify a
   * stranger.
   */
  async create(orgId: string, userId: string, taskId: string, dto: CreateCommentDto) {
    const task = await this.db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)),
    });
    if (!task) throw new NotFoundException("Task not found");

    const members = await this.orgMembers(orgId);
    const memberIds = new Set(members.map((m) => m.id));

    if (dto.assigneeId && !memberIds.has(dto.assigneeId)) {
      throw new BadRequestException("Assignee is not a member of this organization");
    }

    const mentioned = new Set<string>();
    for (const id of dto.mentionedUserIds ?? []) if (memberIds.has(id)) mentioned.add(id);
    for (const id of findMentions(dto.body, members)) mentioned.add(id);
    mentioned.delete(userId);

    const [comment] = await this.db
      .insert(comments)
      .values({
        organizationId: orgId,
        taskId,
        authorId: userId,
        body: dto.body,
        parentCommentId: dto.parentCommentId ?? null,
        assigneeId: dto.assigneeId ?? null,
      })
      .returning();

    await this.notifications.subscribe(orgId, taskId, userId);
    // People you drag into a thread should hear how it ends.
    for (const id of mentioned) await this.notifications.subscribe(orgId, taskId, id);
    if (dto.assigneeId) await this.notifications.subscribe(orgId, taskId, dto.assigneeId);

    await this.activity.record({
      orgId,
      actorId: userId,
      entityType: "task",
      entityId: taskId,
      action: "commented",
    });

    const snippet = dto.body.slice(0, 140);

    // Direct deliveries first, then the ambient fan-out — and exclude the direct
    // receivers from the fan-out so nobody gets the same comment twice.
    if (mentioned.size) {
      await this.notifications.notifyUsers({
        orgId,
        receiverIds: [...mentioned],
        actorId: userId,
        verb: "mentioned",
        entityType: "task",
        entityId: taskId,
        title: task.title,
        body: snippet,
      });
    }
    if (dto.assigneeId) {
      await this.notifications.notifyUsers({
        orgId,
        receiverIds: [dto.assigneeId],
        actorId: userId,
        verb: "comment_assigned",
        entityType: "task",
        entityId: taskId,
        title: task.title,
        body: snippet,
      });
    }
    await this.notifications.notifyTaskEvent({
      orgId,
      taskId,
      actorId: userId,
      verb: "commented",
      title: task.title,
      body: snippet,
      exclude: [...mentioned, ...(dto.assigneeId ? [dto.assigneeId] : [])],
    });

    return this.findOne(orgId, comment!.id);
  }

  async findOne(orgId: string, id: string) {
    const row = await this.db.query.comments.findFirst({
      where: and(eq(comments.id, id), eq(comments.organizationId, orgId)),
      with: { author: true, assignee: true },
    });
    if (!row) throw new NotFoundException("Comment not found");
    return shape(row);
  }

  /** The "Assigned Comments" inbox: action items handed to me, still open. */
  async assignedToMe(orgId: string, userId: string, includeResolved = false) {
    const rows = await this.db.query.comments.findMany({
      where: and(
        eq(comments.organizationId, orgId),
        eq(comments.assigneeId, userId),
        ...(includeResolved ? [] : [isNull(comments.resolvedAt)]),
      ),
      with: { author: true, assignee: true, task: { with: { status: true } } },
      orderBy: desc(comments.createdAt),
      limit: 200,
    });
    return rows.map((r) => ({
      ...shape(r),
      task: r.task
        ? { id: r.task.id, title: r.task.title, reference: r.task.reference, status: r.task.status }
        : null,
    }));
  }

  async openAssignedCount(orgId: string, userId: string) {
    const rows = await this.db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.organizationId, orgId),
          eq(comments.assigneeId, userId),
          isNull(comments.resolvedAt),
        ),
      );
    return { count: rows.length };
  }

  async assign(orgId: string, actorId: string, id: string, assigneeId: string | null) {
    const existing = await this.findOne(orgId, id);
    if (assigneeId) {
      const member = await this.db.query.memberships.findFirst({
        where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, assigneeId)),
      });
      if (!member) throw new BadRequestException("Assignee is not a member of this organization");
    }

    await this.db
      .update(comments)
      .set({ assigneeId, resolvedAt: null, resolvedById: null, updatedAt: new Date() })
      .where(eq(comments.id, id));

    if (assigneeId && assigneeId !== actorId) {
      await this.notifications.subscribe(orgId, existing.taskId, assigneeId);
      const task = await this.db.query.tasks.findFirst({ where: eq(tasks.id, existing.taskId) });
      await this.notifications.notifyUsers({
        orgId,
        receiverIds: [assigneeId],
        actorId,
        verb: "comment_assigned",
        entityType: "task",
        entityId: existing.taskId,
        title: task?.title ?? "a task",
        body: existing.body.slice(0, 140),
      });
    }
    return this.findOne(orgId, id);
  }

  /** Only the assignee or the author may close an action item. */
  async resolve(orgId: string, actorId: string, id: string, resolved: boolean) {
    const existing = await this.findOne(orgId, id);
    if (existing.assignee?.id !== actorId && existing.author.id !== actorId) {
      throw new ForbiddenException("Only the assignee or author can resolve this comment");
    }
    await this.db
      .update(comments)
      .set({
        resolvedAt: resolved ? new Date() : null,
        resolvedById: resolved ? actorId : null,
        updatedAt: new Date(),
      })
      .where(eq(comments.id, id));

    await this.activity.record({
      orgId,
      actorId,
      entityType: "task",
      entityId: existing.taskId,
      action: resolved ? "comment_resolved" : "comment_reopened",
    });
    return this.findOne(orgId, id);
  }

  private async orgMembers(orgId: string) {
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, orgId));
    return rows;
  }
}

/**
 * Finds `@Name` in free text. Longest names are tried first so "@Arfin Siam"
 * matches the full name rather than stopping at a shorter "@Arfin" elsewhere.
 * Case-insensitive; only real members can match, so this can never resolve to
 * someone outside the org.
 */
export function findMentions(body: string, members: { id: string; name: string }[]) {
  const lower = body.toLowerCase();
  const found = new Set<string>();
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const needle = `@${m.name.toLowerCase()}`;
    const first = `@${m.name.split(" ")[0]!.toLowerCase()}`;
    if (lower.includes(needle) || lower.includes(first)) found.add(m.id);
  }
  return found;
}

function shape(r: {
  id: string;
  taskId: string;
  body: string;
  parentCommentId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  author: { id: string; name: string; avatarUrl: string | null };
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
}) {
  return {
    id: r.id,
    taskId: r.taskId,
    body: r.body,
    parentCommentId: r.parentCommentId,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    author: { id: r.author.id, name: r.author.name, avatarUrl: r.author.avatarUrl },
    assignee: r.assignee
      ? { id: r.assignee.id, name: r.assignee.name, avatarUrl: r.assignee.avatarUrl }
      : null,
  };
}
