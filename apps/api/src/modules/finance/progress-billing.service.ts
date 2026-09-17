import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { invoiceItems, invoices, projectStages, projects } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { InvoicesService } from "./invoices.service.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.005;

/**
 * Row 137: fixed-fee progress billing. Each stage carries a fee and a
 * hand-set % complete (row 105); what is due now is fee × % − what earlier
 * invoices already billed for that stage. Voided invoices do not count as
 * billed, so a redo never double-charges.
 */
@Injectable()
export class ProgressBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly invoicesService: InvoicesService,
  ) {}

  async forProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true, name: true, currency: true, budgetAmount: true } });
    if (!project) throw new NotFoundException("Project not found");
    const stages = await this.db.query.projectStages.findMany({ where: and(eq(projectStages.projectId, projectId), isNull(projectStages.archivedAt)), orderBy: [asc(projectStages.position), asc(projectStages.createdAt)] });
    const ids = stages.map((s) => s.id);
    const billedRows = ids.length
      ? await this.db
          .select({ stageId: invoiceItems.stageId, billed: sql<number>`coalesce(sum(${invoiceItems.amount}), 0)::float`, pct: sql<number>`coalesce(max(${invoiceItems.billedPct}), 0)::int`, invoiceNumber: invoices.number, invoiceId: invoices.id, status: invoices.status })
          .from(invoiceItems)
          .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
          .where(and(inArray(invoiceItems.stageId, ids), ne(invoices.status, "void"), isNull(invoices.archivedAt)))
          .groupBy(invoiceItems.stageId, invoices.number, invoices.id, invoices.status)
      : [];
    const rows = stages.map((s, i) => {
      const bills = billedRows.filter((b) => b.stageId === s.id);
      const billed = round2(bills.reduce((a, b) => a + b.billed, 0));
      const billedPct = bills.reduce((a, b) => Math.max(a, b.pct), 0);
      const fee = s.feeAmount ?? 0;
      const earned = round2(fee * (s.progressPct / 100));
      const due = round2(Math.max(0, earned - billed));
      return {
        id: s.id,
        index: i + 1,
        name: s.name,
        status: s.status,
        progressPct: s.progressPct,
        progressSetAt: s.progressSetAt,
        feeAmount: s.feeAmount,
        earned,
        billed,
        billedPct,
        due,
        overBilled: billed > earned + EPS ? round2(billed - earned) : 0,
        invoices: bills.map((b) => ({ id: b.invoiceId, number: b.invoiceNumber, status: b.status, amount: round2(b.billed) })),
      };
    });
    const feeTotal = round2(rows.reduce((a, r) => a + (r.feeAmount ?? 0), 0));
    return {
      project: { id: project.id, name: project.name, currency: project.currency, budgetAmount: project.budgetAmount },
      stages: rows,
      totals: { fee: feeTotal, earned: round2(rows.reduce((a, r) => a + r.earned, 0)), billed: round2(rows.reduce((a, r) => a + r.billed, 0)), due: round2(rows.reduce((a, r) => a + r.due, 0)), feesMissing: rows.filter((r) => r.feeAmount == null).length },
    };
  }

  /** One invoice line per stage with something due; the line records the % it bills up to. */
  async draft(orgId: string, userId: string, dto: { projectId: string; stageIds?: string[] | null; title?: string | null }) {
    const p = await this.forProject(orgId, dto.projectId);
    const stages = p.stages.filter((s) => s.due > EPS && (!dto.stageIds || dto.stageIds.includes(s.id)));
    if (!stages.length) throw new BadRequestException("Nothing is due — set stage fees and progress first");
    const items = stages.map((s) => ({
      description: `Stage ${s.index} — ${s.name}: ${s.progressPct}% of ${p.project.currency} ${(s.feeAmount ?? 0).toFixed(2)}${s.billed > 0 ? ` (less ${p.project.currency} ${s.billed.toFixed(2)} billed to ${s.billedPct}%)` : ""}`,
      quantity: 1,
      unitPrice: s.due,
      stageId: s.id,
      billedPct: s.progressPct,
    }));
    const inv = await this.invoicesService.create(orgId, userId, { projectId: p.project.id, title: dto.title?.trim() || `${p.project.name} — progress invoice`, items });
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: inv.id, action: "drafted_from_progress", changes: stages.map((s) => ({ field: s.name, from: String(s.billedPct), to: String(s.progressPct) })) });
    return inv;
  }
}
