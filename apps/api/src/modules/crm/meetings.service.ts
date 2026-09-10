import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { meetingAttendees, meetings, memberships } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { Role } from "../auth/auth.types.js";

export interface MeetingDto {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  location?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  attendeeIds?: string[];
}

@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Meetings in a window, soonest first. Defaults to the next 30 days. */
  async list(orgId: string, opts: { from?: string; to?: string; mine?: string } = {}) {
    const from = opts.from ? new Date(opts.from) : new Date();
    const to = opts.to ? new Date(opts.to) : new Date(from.getTime() + 30 * 86_400_000);

    const rows = await this.db.query.meetings.findMany({
      where: and(
        eq(meetings.organizationId, orgId),
        gte(meetings.startsAt, from),
        lt(meetings.startsAt, to),
      ),
      with: { company: true, contact: true, deal: true, organizer: true, attendees: { with: { user: true } } },
      orderBy: asc(meetings.startsAt),
    });
    const shaped = rows.map(shape);
    return opts.mine
      ? shaped.filter((m) => m.organizer.id === opts.mine || m.attendees.some((a) => a.id === opts.mine))
      : shaped;
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.organizationId, orgId)),
      with: { company: true, contact: true, deal: true, organizer: true, attendees: { with: { user: true } } },
    });
    if (!row) throw new NotFoundException("Meeting not found");
    return shape(row);
  }

  async create(orgId: string, userId: string, dto: MeetingDto) {
    const { startsAt, endsAt } = this.window(dto.startsAt, dto.endsAt);
    const attendees = await this.validAttendees(orgId, dto.attendeeIds ?? []);

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(meetings)
        .values({
          organizationId: orgId,
          organizerId: userId,
          title: dto.title,
          description: dto.description ?? null,
          startsAt,
          endsAt,
          location: dto.location ?? null,
          companyId: dto.companyId ?? null,
          contactId: dto.contactId ?? null,
          dealId: dto.dealId ?? null,
        })
        .returning();
      // The organizer is always in the room.
      const ids = new Set([...attendees, userId]);
      await tx.insert(meetingAttendees).values([...ids].map((u) => ({ meetingId: row!.id, userId: u, organizationId: orgId })));
      return row!.id;
    });

    await this.activity.record({ orgId, actorId: userId, entityType: "meeting", entityId: id, action: "created" });
    await this.notifications.notifyUsers({
      orgId,
      receiverIds: attendees,
      actorId: userId,
      verb: "mentioned",
      entityType: "meeting",
      entityId: id,
      title: dto.title,
      body: `invited you to a meeting on ${startsAt.toLocaleString()}`,
    });
    return this.get(orgId, id);
  }

  async update(orgId: string, actor: { userId: string; role: Role }, id: string, dto: Partial<MeetingDto>) {
    const before = await this.owned(orgId, actor, id);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["title", "description", "location", "companyId", "contactId", "dealId"] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
    if (dto.startsAt || dto.endsAt) {
      const w = this.window(dto.startsAt ?? before.startsAt.toISOString(), dto.endsAt ?? before.endsAt.toISOString());
      patch.startsAt = w.startsAt;
      patch.endsAt = w.endsAt;
    }

    await this.db.transaction(async (tx) => {
      await tx.update(meetings).set(patch).where(eq(meetings.id, id));
      if (dto.attendeeIds) {
        const valid = await this.validAttendees(orgId, dto.attendeeIds);
        const ids = new Set([...valid, before.organizer.id]);
        await tx.delete(meetingAttendees).where(eq(meetingAttendees.meetingId, id));
        await tx.insert(meetingAttendees).values([...ids].map((u) => ({ meetingId: id, userId: u, organizationId: orgId })));
      }
    });

    await this.activity.record({ orgId, actorId: actor.userId, entityType: "meeting", entityId: id, action: "updated" });
    return this.get(orgId, id);
  }

  async remove(orgId: string, actor: { userId: string; role: Role }, id: string) {
    await this.owned(orgId, actor, id);
    await this.db.delete(meetings).where(eq(meetings.id, id));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "meeting", entityId: id, action: "cancelled" });
    return { id, deleted: true };
  }

  private window(start: string, end: string) {
    const startsAt = new Date(start);
    const endsAt = new Date(end);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException("Invalid meeting time");
    }
    if (endsAt <= startsAt) throw new BadRequestException("A meeting must end after it starts");
    return { startsAt, endsAt };
  }

  /** Only members of this org can be invited — silently drops anyone else. */
  private async validAttendees(orgId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), inArray(memberships.userId, ids)));
    return rows.map((r) => r.userId);
  }

  /** Organizer or admin may change or cancel. */
  private async owned(orgId: string, actor: { userId: string; role: Role }, id: string) {
    const m = await this.get(orgId, id);
    const isAdmin = actor.role === "owner" || actor.role === "admin";
    if (m.organizer.id !== actor.userId && !isAdmin) {
      throw new ForbiddenException("Only the organizer can change this meeting");
    }
    return m;
  }
}

function shape(r: typeof meetings.$inferSelect & {
  company: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string | null } | null;
  deal: { id: string; title: string } | null;
  organizer: { id: string; name: string };
  attendees: { user: { id: string; name: string; avatarUrl: string | null } }[];
}) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    location: r.location,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact
      ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") }
      : null,
    deal: r.deal ? { id: r.deal.id, title: r.deal.title } : null,
    organizer: { id: r.organizer.id, name: r.organizer.name },
    attendees: r.attendees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
  };
}
