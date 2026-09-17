import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { AgencyReportsService, type Range } from "./agency-reports.service.js";

function range(from?: string, to?: string): Range {
  const now = new Date();
  const start = from ? new Date(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = to ? new Date(to) : now;
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);
  return { from: start, to: end };
}
function send(res: Response, csv: string, filename: string) {
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + csv);
}

/** Rows 142-146. Every report has a .csv twin so the numbers can leave the app. Owner/admin only. */
@Controller("finance/reports")
@Roles("owner", "admin")
export class AgencyReportsController {
  constructor(private readonly reports: AgencyReportsService) {}

  @Get("utilization")
  utilization(@Auth() auth: AuthContext, @Query("from") from?: string, @Query("to") to?: string) {
    return this.reports.utilization(auth.orgId, range(from, to));
  }

  @Get("utilization.csv")
  async utilizationCsv(@Auth() auth: AuthContext, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const r = await this.reports.utilization(auth.orgId, range(from, to));
    const rows = [...r.people, { name: "Team", role: "", capacity: r.team.capacity, holidayHours: "", leaveHours: "", available: r.team.available, loggedHours: r.team.logged, billableHours: r.team.billable, internalHours: "", billableUtilizationPct: r.team.billableUtilizationPct, loggedUtilizationPct: r.team.loggedUtilizationPct }];
    send(res, this.reports.csv(rows as Record<string, unknown>[], [{ key: "name", label: "Person" }, { key: "role", label: "Role" }, { key: "capacity", label: "Capacity h" }, { key: "holidayHours", label: "Holidays h" }, { key: "leaveHours", label: "Leave h" }, { key: "available", label: "Available h" }, { key: "loggedHours", label: "Logged h" }, { key: "billableHours", label: "Billable h" }, { key: "internalHours", label: "Internal h" }, { key: "billableUtilizationPct", label: "Billable util %" }, { key: "loggedUtilizationPct", label: "Logged util %" }]), `utilization-${r.from.slice(0, 10)}-to-${r.to.slice(0, 10)}.csv`);
  }

  @Get("profitability")
  profitability(@Auth() auth: AuthContext, @Query("from") from?: string, @Query("to") to?: string, @Query("all") all?: string) {
    return this.reports.profitability(auth.orgId, all === "1" ? null : range(from, to));
  }

  @Get("profitability.csv")
  async profitabilityCsv(@Auth() auth: AuthContext, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string, @Query("all") all?: string) {
    const r = await this.reports.profitability(auth.orgId, all === "1" ? null : range(from, to));
    send(res, this.reports.csv([...r.projects, { name: "Total", ...r.totals }] as Record<string, unknown>[], [{ key: "name", label: "Project" }, { key: "client", label: "Client" }, { key: "status", label: "Status" }, { key: "revenue", label: "Revenue" }, { key: "collected", label: "Collected" }, { key: "hours", label: "Hours" }, { key: "labourCost", label: "Labour cost" }, { key: "expenses", label: "Expenses" }, { key: "contractorCost", label: "of which freelancers" }, { key: "cost", label: "Total cost" }, { key: "margin", label: "Margin" }, { key: "marginPct", label: "Margin %" }, { key: "effectiveRate", label: "Effective rate/h" }]), `profitability${r.from ? `-${r.from.slice(0, 10)}-to-${r.to!.slice(0, 10)}` : "-all-time"}.csv`);
  }

  @Get("wip")
  wip(@Auth() auth: AuthContext, @Query("onlyApproved") onlyApproved?: string) {
    return this.reports.wip(auth.orgId, onlyApproved !== "0");
  }

  @Get("wip.csv")
  async wipCsv(@Auth() auth: AuthContext, @Res() res: Response, @Query("onlyApproved") onlyApproved?: string) {
    const r = await this.reports.wip(auth.orgId, onlyApproved !== "0");
    const rows = r.projects.map((p) => ({ name: p.project.name, currency: p.project.currency, hours: p.hours, hoursAmount: p.hoursAmount, awaitingHours: p.awaitingHours, expensesCount: p.expensesCount, expensesAmount: p.expensesAmount, total: p.total }));
    send(res, this.reports.csv([...rows, { name: "Total", ...r.totals }] as Record<string, unknown>[], [{ key: "name", label: "Project" }, { key: "currency", label: "Currency" }, { key: "hours", label: "Unbilled hours" }, { key: "hoursAmount", label: "Hours value" }, { key: "awaitingHours", label: "Hours awaiting approval" }, { key: "expensesCount", label: "Unbilled expenses" }, { key: "expensesAmount", label: "Expenses value" }, { key: "total", label: "WIP" }]), `wip-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  @Get("receivables")
  receivables(@Auth() auth: AuthContext, @Query("asOf") asOf?: string) {
    return this.reports.agedReceivables(auth.orgId, asOf ? new Date(asOf) : new Date());
  }

  @Get("receivables.csv")
  async receivablesCsv(@Auth() auth: AuthContext, @Res() res: Response, @Query("asOf") asOf?: string) {
    const r = await this.reports.agedReceivables(auth.orgId, asOf ? new Date(asOf) : new Date());
    const rows = r.clients.flatMap((c) => c.invoices.map((i) => ({ client: c.name, number: i.number, title: i.title, dueDate: i.dueDate, daysOverdue: i.daysOverdue, bucket: i.bucket, balance: i.balance, currency: i.currency })));
    send(res, this.reports.csv(rows as Record<string, unknown>[], [{ key: "client", label: "Client" }, { key: "number", label: "Invoice" }, { key: "title", label: "Title" }, { key: "dueDate", label: "Due" }, { key: "daysOverdue", label: "Days overdue" }, { key: "bucket", label: "Bucket" }, { key: "balance", label: "Balance" }, { key: "currency", label: "Currency" }]), `aged-receivables-${r.asOf.slice(0, 10)}.csv`);
  }

  @Get("kpis")
  kpis(@Auth() auth: AuthContext) {
    return this.reports.kpis(auth.orgId);
  }
}
