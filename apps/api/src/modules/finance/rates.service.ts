import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { memberRates, memberships, projectMemberRates, projects, users } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export interface RateLookup {
  billRate: number;
  costRate: number;
  /** Where the bill rate came from. */
  source: "project_override" | "member" | "project_default" | "none";
  currency: string;
}

/**
 * Rows 140-141: effective-dated rate cards. The rate for an hour is the one
 * in force on the day the work started — a project override first, then the
 * member's card, then the project's flat hourly rate — so changing rates
 * later never rewrites history. Cost rates and margins are owner/admin only.
 */
@Injectable()
export class RatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  /* ---------------- lookup ---------------- */

  /** Loads everything once so callers can resolve thousands of entries in memory. */
  async resolver(orgId: string, projectIds: string[] = []) {
    const [cards, overrides, projs] = await Promise.all([
      this.db.query.memberRates.findMany({ where: eq(memberRates.organizationId, orgId), orderBy: [desc(memberRates.effectiveFrom)] }),
      projectIds.length ? this.db.query.projectMemberRates.findMany({ where: and(eq(projectMemberRates.organizationId, orgId), inArray(projectMemberRates.projectId, projectIds)), orderBy: [desc(projectMemberRates.effectiveFrom)] }) : Promise.resolve([]),
      projectIds.length ? this.db.select({ id: projects.id, hourlyRate: projects.hourlyRate, currency: projects.currency }).from(projects).where(inArray(projects.id, projectIds)) : Promise.resolve([]),
    ]);
    const projBy = new Map(projs.map((p) => [p.id, p]));
    return (userId: string, projectId: string | null, at: Date): RateLookup => {
      const t = at.getTime();
      const ov = projectId ? overrides.find((o) => o.projectId === projectId && o.userId === userId && o.effectiveFrom.getTime() <= t) : undefined;
      const card = cards.find((c) => c.userId === userId && c.effectiveFrom.getTime() <= t);
      const proj = projectId ? projBy.get(projectId) : undefined;
      const currency = card?.currency ?? proj?.currency ?? "USD";
      const costRate = card?.costRate ?? 0;
      if (ov) return { billRate: ov.billRate, costRate, source: "project_override", currency };
      if (card) return { billRate: card.billRate, costRate, source: "member", currency };
      if (proj?.hourlyRate) return { billRate: proj.hourlyRate, costRate, source: "project_default", currency };
      return { billRate: 0, costRate, source: "none", currency };
    };
  }

  async rateFor(orgId: string, userId: string, projectId: string | null, at: Date) {
    return (await this.resolver(orgId, projectId ? [projectId] : []))(userId, projectId, at);
  }

  /* ---------------- member cards ---------------- */

  async list(orgId: string) {
    const [members, cards] = await Promise.all([
      this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), with: { user: { columns: { id: true, name: true, email: true } } } }),
      this.db.query.memberRates.findMany({ where: eq(memberRates.organizationId, orgId), with: { createdBy: { columns: { id: true, name: true } } }, orderBy: [desc(memberRates.effectiveFrom)] }),
    ]);
    const now = Date.now();
    return members
      .filter((m) => !m.deactivatedAt)
      .map((m) => {
        const history = cards.filter((c) => c.userId === m.userId).map(shape);
        const current = history.find((c) => new Date(c.effectiveFrom).getTime() <= now) ?? null;
        const upcoming = history.filter((c) => new Date(c.effectiveFrom).getTime() > now);
        return { userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, current, upcoming, history };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async add(orgId: string, actorId: string, dto: { userId: string; effectiveFrom: string; billRate: number; costRate: number; currency?: string; note?: string | null }) {
    const m = await this.db.query.memberships.findFirst({ where: and(eq(memberships.organizationId, orgId), eq(memberships.userId, dto.userId)), columns: { id: true } });
    if (!m) throw new NotFoundException("Not a member of this workspace");
    const from = dayStart(dto.effectiveFrom);
    if (dto.billRate < 0 || dto.costRate < 0) throw new BadRequestException("Rates cannot be negative");
    const [row] = await this.db
      .insert(memberRates)
      .values({ organizationId: orgId, userId: dto.userId, effectiveFrom: from, billRate: round2(dto.billRate), costRate: round2(dto.costRate), currency: (dto.currency ?? "USD").toUpperCase(), note: dto.note?.trim() || null, createdById: actorId })
      .onConflictDoUpdate({ target: [memberRates.userId, memberRates.effectiveFrom], set: { billRate: round2(dto.billRate), costRate: round2(dto.costRate), currency: (dto.currency ?? "USD").toUpperCase(), note: dto.note?.trim() || null, createdById: actorId } })
      .returning();
    const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, dto.userId));
    await this.activity.record({ orgId, actorId, entityType: "member", entityId: dto.userId, action: "rate_set", changes: [{ field: "billRate", from: null, to: dto.billRate }, { field: "costRate", from: null, to: dto.costRate }, { field: "effectiveFrom", from: null, to: from.toISOString().slice(0, 10) }, { field: "member", from: null, to: u?.name ?? dto.userId }] });
    return shape(row!);
  }

  async remove(orgId: string, actorId: string, id: string) {
    const row = await this.db.query.memberRates.findFirst({ where: and(eq(memberRates.id, id), eq(memberRates.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Rate not found");
    await this.db.delete(memberRates).where(eq(memberRates.id, id));
    await this.activity.record({ orgId, actorId, entityType: "member", entityId: row.userId, action: "rate_removed", changes: [{ field: "effectiveFrom", from: row.effectiveFrom.toISOString().slice(0, 10), to: null }] });
    return { id, removed: true };
  }

  /* ---------------- project overrides ---------------- */

  async forProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true, hourlyRate: true, currency: true } });
    if (!project) throw new NotFoundException("Project not found");
    const [rows, members] = await Promise.all([
      this.db.query.projectMemberRates.findMany({ where: eq(projectMemberRates.projectId, projectId), with: { user: { columns: { id: true, name: true } } }, orderBy: [asc(projectMemberRates.userId), desc(projectMemberRates.effectiveFrom)] }),
      this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), with: { user: { columns: { id: true, name: true } } } }),
    ]);
    const resolve = await this.resolver(orgId, [projectId]);
    const now = new Date();
    return {
      project: { id: project.id, hourlyRate: project.hourlyRate, currency: project.currency },
      overrides: rows.map((r) => ({ id: r.id, userId: r.userId, userName: r.user.name, effectiveFrom: r.effectiveFrom, billRate: r.billRate, note: r.note, active: r.effectiveFrom <= now })),
      /** What each member bills at on this project right now, and why. */
      effective: members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.user.name, ...resolve(m.userId, projectId, now) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async addOverride(orgId: string, actorId: string, projectId: string, dto: { userId: string; effectiveFrom: string; billRate: number; note?: string | null }) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true, name: true } });
    if (!project) throw new NotFoundException("Project not found");
    if (dto.billRate < 0) throw new BadRequestException("Rate cannot be negative");
    const from = dayStart(dto.effectiveFrom);
    const [row] = await this.db
      .insert(projectMemberRates)
      .values({ organizationId: orgId, projectId, userId: dto.userId, effectiveFrom: from, billRate: round2(dto.billRate), note: dto.note?.trim() || null, createdById: actorId })
      .onConflictDoUpdate({ target: [projectMemberRates.projectId, projectMemberRates.userId, projectMemberRates.effectiveFrom], set: { billRate: round2(dto.billRate), note: dto.note?.trim() || null, createdById: actorId } })
      .returning();
    await this.activity.record({ orgId, actorId, entityType: "project", entityId: projectId, action: "rate_override_set", changes: [{ field: "member", from: null, to: dto.userId }, { field: "billRate", from: null, to: dto.billRate }, { field: "effectiveFrom", from: null, to: from.toISOString().slice(0, 10) }] });
    return { id: row!.id };
  }

  async removeOverride(orgId: string, actorId: string, projectId: string, id: string) {
    const row = await this.db.query.projectMemberRates.findFirst({ where: and(eq(projectMemberRates.id, id), eq(projectMemberRates.projectId, projectId), eq(projectMemberRates.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Override not found");
    await this.db.delete(projectMemberRates).where(eq(projectMemberRates.id, id));
    await this.activity.record({ orgId, actorId, entityType: "project", entityId: projectId, action: "rate_override_removed", changes: [{ field: "member", from: row.userId, to: null }] });
    return { id, removed: true };
  }
}

function dayStart(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("Invalid date");
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
function shape(r: typeof memberRates.$inferSelect & { createdBy?: { id: string; name: string } | null }) {
  return { id: r.id, userId: r.userId, effectiveFrom: r.effectiveFrom.toISOString(), billRate: r.billRate, costRate: r.costRate, currency: r.currency, note: r.note, createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null, createdAt: r.createdAt.toISOString() };
}
