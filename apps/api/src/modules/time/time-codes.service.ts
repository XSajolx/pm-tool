import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { projects } from "../../db/schema.js";

/** Row 91: the codes every workspace starts with. */
export const DEFAULT_TIME_CODES: { name: string; color: string }[] = [
  { name: "Admin", color: "#64748b" },
  { name: "Internal", color: "#0ea5e9" },
  { name: "Training", color: "#8b5cf6" },
  { name: "Sales", color: "#f59e0b" },
  { name: "PTO", color: "#10b981" },
];

/**
 * Row 91: internal time codes are projects of kind "internal" - no client, no
 * space, never billable - so timesheets, timers and summaries treat them like
 * any other row and a full week can always be accounted for.
 */
@Injectable()
export class TimeCodesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async list(orgId: string, includeArchived = false) {
    await this.ensureDefaults(orgId);
    const rows = await this.db.query.projects.findMany({
      where: and(eq(projects.organizationId, orgId), eq(projects.kind, "internal"), ...(includeArchived ? [] : [isNull(projects.archivedAt)])),
      columns: { id: true, name: true, color: true, archivedAt: true, createdAt: true },
      orderBy: [asc(projects.createdAt)],
    });
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, archived: Boolean(r.archivedAt) }));
  }

  /** Seed the five defaults the first time a workspace asks for its codes. */
  async ensureDefaults(orgId: string) {
    const existing = await this.db.query.projects.findFirst({ where: and(eq(projects.organizationId, orgId), eq(projects.kind, "internal")), columns: { id: true } });
    if (existing) return;
    await this.db.insert(projects).values(
      DEFAULT_TIME_CODES.map((c) => ({ organizationId: orgId, name: c.name, color: c.color, kind: "internal", status: "active" as const, currency: "USD", hourlyRate: 0 })),
    );
  }

  async create(orgId: string, name: string, color?: string) {
    const clean = name.trim();
    if (!clean) throw new BadRequestException("Name is required");
    const [row] = await this.db
      .insert(projects)
      .values({ organizationId: orgId, name: clean, color: color ?? "#64748b", kind: "internal", status: "active", currency: "USD", hourlyRate: 0 })
      .returning({ id: projects.id, name: projects.name, color: projects.color });
    return { ...row!, archived: false };
  }

  async update(orgId: string, id: string, patch: { name?: string; color?: string; archived?: boolean }) {
    const code = await this.db.query.projects.findFirst({ where: and(eq(projects.id, id), eq(projects.organizationId, orgId), eq(projects.kind, "internal")), columns: { id: true } });
    if (!code) throw new NotFoundException("Time code not found");
    await this.db
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id));
    const [row] = await this.db.select({ id: projects.id, name: projects.name, color: projects.color, archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, id));
    return { id: row!.id, name: row!.name, color: row!.color, archived: Boolean(row!.archivedAt) };
  }

  /** Is this project an internal code? (Used to force non-billable time.) */
  async isInternal(orgId: string, projectId: string) {
    const row = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { kind: true } });
    return row?.kind === "internal";
  }
}
