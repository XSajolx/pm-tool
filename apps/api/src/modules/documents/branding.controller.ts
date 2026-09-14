import { Body, Controller, Get, Inject, Patch, UsePipes } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { organizations } from "../../db/schema.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandLogoUrl: z.string().max(2000).nullable().optional(),
  brandFooter: z.string().max(255).nullable().optional(),
});

/** Row 67: the workspace's brand — colour, logo, footer — used on PDF exports and client pages. */
@Controller("branding")
export class BrandingController {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  @Get()
  async get(@Auth() auth: AuthContext) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, auth.orgId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true } });
    return org ?? { name: "", brandColor: "#6366f1", brandLogoUrl: null, brandFooter: null };
  }

  @Patch()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(schema))
  async update(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    await this.db.update(organizations).set({ ...dto, updatedAt: new Date() }).where(eq(organizations.id, auth.orgId));
    return this.get(auth);
  }
}
