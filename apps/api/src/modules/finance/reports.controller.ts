import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ReportsService, type Basis, type Granularity } from "./reports.service.js";

/** Row 161 (P&L). Money reports are owner/admin only. */
@Controller("finance/reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("pnl")
  @Roles("owner", "admin")
  pnl(@Auth() auth: AuthContext, @Query("from") from?: string, @Query("to") to?: string, @Query("granularity") granularity?: string, @Query("basis") basis?: string) {
    return this.reports.pnl(auth.orgId, { from, to, granularity: pick(granularity, ["month", "quarter", "year"]) as Granularity | undefined, basis: pick(basis, ["cash", "accrual"]) as Basis | undefined });
  }

  @Get("pnl.csv")
  @Roles("owner", "admin")
  async pnlCsv(@Auth() auth: AuthContext, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string, @Query("granularity") granularity?: string, @Query("basis") basis?: string) {
    const { csv, filename } = await this.reports.pnlCsv(auth.orgId, { from, to, granularity: pick(granularity, ["month", "quarter", "year"]) as Granularity | undefined, basis: pick(basis, ["cash", "accrual"]) as Basis | undefined });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.send("﻿" + csv);
  }
}

function pick(v: string | undefined, allowed: string[]) {
  return v && allowed.includes(v) ? v : undefined;
}
