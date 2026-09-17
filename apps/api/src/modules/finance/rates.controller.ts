import { Body, Controller, Delete, Get, Param, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { RatesService } from "./rates.service.js";

const cardSchema = z.object({ userId: z.string().uuid(), effectiveFrom: z.string().min(8), billRate: z.number().min(0), costRate: z.number().min(0), currency: z.string().length(3).optional(), note: z.string().max(500).nullable().optional() });
const overrideSchema = z.object({ userId: z.string().uuid(), effectiveFrom: z.string().min(8), billRate: z.number().min(0), note: z.string().max(500).nullable().optional() });

/** Rows 140-141. Rates, costs and margins are for owners/admins only — nobody below PM sees them. */
@Controller("finance/rates")
@Roles("owner", "admin")
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.rates.list(auth.orgId);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(cardSchema))
  add(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof cardSchema>) {
    return this.rates.add(auth.orgId, auth.userId, dto);
  }

  @Delete(":id")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.rates.remove(auth.orgId, auth.userId, id);
  }

  @Get("project/:projectId")
  forProject(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.rates.forProject(auth.orgId, projectId);
  }

  @Post("project/:projectId")
  @UsePipes(new ZodValidationPipe(overrideSchema))
  addOverride(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Body() dto: z.infer<typeof overrideSchema>) {
    return this.rates.addOverride(auth.orgId, auth.userId, projectId, dto);
  }

  @Delete("project/:projectId/:id")
  removeOverride(@Auth() auth: AuthContext, @Param("projectId") projectId: string, @Param("id") id: string) {
    return this.rates.removeOverride(auth.orgId, auth.userId, projectId, id);
  }
}
