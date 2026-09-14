import { Body, Controller, Get, Inject, Patch, UsePipes } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { organizations } from "../../db/schema.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  /** Row 108: the workspace name is part of the brand. */
  name: z.string().trim().min(1).max(255).optional(),
  brandFaviconUrl: z.string().max(2000).nullable().optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandLogoUrl: z.string().max(2000).nullable().optional(),
  brandFooter: z.string().max(255).nullable().optional(),
});

/** Row 107: label + palette colour per priority level. */
const level = z.object({ label: z.string().min(1).max(24), color: z.enum(["red", "orange", "amber", "yellow", "green", "teal", "blue", "indigo", "purple", "pink", "slate"]) }).optional();
const prioritySchema = z.object({ urgent: level, high: level, normal: level, low: level });

/** Row 67: the workspace's brand — colour, logo, footer — used on PDF exports and client pages. */
@Controller("branding")
export class BrandingController {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly activity: ActivityService) {}

  @Get()
  async get(@Auth() auth: AuthContext) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, auth.orgId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true, brandFaviconUrl: true } });
    return org ?? { name: "", brandColor: "#6366f1", brandLogoUrl: null, brandFooter: null, brandFaviconUrl: null };
  }

  @Patch()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(schema))
  async update(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    const before = await this.get(auth);
    await this.db.update(organizations).set({ ...dto, updatedAt: new Date() }).where(eq(organizations.id, auth.orgId));
    // Row 115: settings changes are auditable.
    const changes = Object.entries(dto).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v).map(([k, v]) => ({ field: k, from: (before as Record<string, unknown>)[k] ?? null, to: v ?? null }));
    if (changes.length) await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "branding_updated", changes });
    return this.get(auth);
  }

  /** Row 107: priority names and colours (defaults when nothing is stored). */
  @Get("priorities")
  async priorities(@Auth() auth: AuthContext) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, auth.orgId), columns: { priorityLabels: true } });
    return org?.priorityLabels ?? {};
  }

  @Patch("priorities")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(prioritySchema))
  async setPriorities(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof prioritySchema>) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, auth.orgId), columns: { priorityLabels: true } });
    const next = { ...(org?.priorityLabels ?? {}), ...dto };
    await this.db.update(organizations).set({ priorityLabels: next, updatedAt: new Date() }).where(eq(organizations.id, auth.orgId));
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "priorities_updated", changes: Object.entries(dto).map(([k, v]) => ({ field: k, from: (org?.priorityLabels as Record<string, unknown> | null)?.[k] ?? null, to: v ?? null })) });
    return next;
  }
}
