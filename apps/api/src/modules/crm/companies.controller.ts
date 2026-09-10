import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CompaniesService } from "./companies.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  name: z.string().min(1).max(255),
  website: z.string().max(512).optional(),
  industry: z.string().max(128).optional(),
  email: z.string().email().max(320).optional().or(z.literal("")),
  phone: z.string().max(64).optional(),
  address: z.string().max(2000).optional(),
  ownerId: z.string().uuid().nullable().optional(),
});

@Controller("crm/companies")
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("q") q?: string) {
    return this.companies.list(auth.orgId, q?.trim() || undefined);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.companies.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.companies.create(auth.orgId, auth.userId, { ...dto, email: dto.email || undefined });
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.companies.update(auth.orgId, auth.userId, id, { ...dto, email: dto.email || undefined });
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.companies.archive(auth.orgId, auth.userId, id);
  }
}
