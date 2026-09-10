import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { MeetingsService } from "./meetings.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const schema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  location: z.string().max(512).nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  attendeeIds: z.array(z.string().uuid()).max(100).optional(),
});

@Controller("crm/meetings")
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  /** `?from&to` window (default: next 30 days); `?mine=true` = ones I'm in. */
  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("mine") mine?: string,
  ) {
    return this.meetings.list(auth.orgId, { from, to, mine: mine === "true" ? auth.userId : undefined });
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.meetings.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof schema>) {
    return this.meetings.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(schema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof schema>>) {
    return this.meetings.update(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.meetings.remove(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }
}
