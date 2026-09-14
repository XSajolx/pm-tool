import { Controller, Get, Query } from "@nestjs/common";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ActivityService } from "./activity.service.js";

/** Row 115: the workspace audit log (admins). */
@Controller("audit")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Roles("owner", "admin")
  list(
    @Auth() auth: AuthContext,
    @Query("q") q?: string,
    @Query("entityType") entityType?: string,
    @Query("actorId") actorId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.activity.listAudit(auth.orgId, { q, entityType: entityType || undefined, actorId: actorId || undefined, from: from || undefined, to: to || undefined, cursor: cursor || undefined, limit: limit ? Number(limit) : undefined });
  }
}
