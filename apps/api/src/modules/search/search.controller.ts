import { Controller, Get, Query } from "@nestjs/common";
import { Auth } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { SearchService } from "./search.service.js";

/** Row 123: global search. */
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(@Auth() auth: AuthContext, @Query("q") q = "", @Query("limit") limit?: string) {
    const per = Math.min(20, Math.max(3, Number(limit) || 8));
    return this.search.search(auth.orgId, { userId: auth.userId, role: auth.role }, q, per);
  }
}
