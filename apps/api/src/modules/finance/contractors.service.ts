import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { contractors, expenses, projectContractors, projects } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { ExpensesService } from "./expenses.service.js";

export interface ContractorDto {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  role?: string | null;
  defaultRate?: number | null;
  currency?: string;
  notes?: string | null;
  active?: boolean;
}

export interface EngageDto {
  contractorId?: string | null;
  /** Create the freelancer on the spot. */
  name?: string | null;
  email?: string | null;
  role?: string | null;
  agreedAmount?: number | null;
  agreedRate?: number | null;
  markupPct?: number | null;
  notes?: string | null;
}

export interface ContractorInvoiceDto {
  projectId: string;
  ref?: string | null;
  description?: string | null;
  amount: number;
  currency?: string;
  date?: string | null;
  dueDate?: string | null;
  markupPct?: number | null;
  billable?: boolean;
  receiptUrl?: string | null;
  paid?: boolean;
}

type Actor = { userId: string; role: string };
const CATEGORY = "Contractors & freelancers";
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Row 135: freelancers and subcontractors. A person is recorded once, engaged
 * on projects with what was agreed, and their invoices are logged as expenses
 * that know who sent them and whether they have been paid — so outside costs
 * sit in project cost, re-bill with markup (row 134), and go through the
 * approval queue (row 133) like any other cost.
 */
@Injectable()
export class ContractorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly expensesService: ExpensesService,
  ) {}

  private isAdmin(a: Actor) {
    return a.role === "owner" || a.role === "admin";
  }

  /** Project managers = owners/admins + the project's lead. */
  private async canManage(orgId: string, actor: Actor, projectId: string) {
    if (this.isAdmin(actor)) return true;
    const p = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { leadId: true } });
    return p?.leadId === actor.userId;
  }

  /* ---------------- directory ---------------- */

  async list(orgId: string, includeInactive = false) {
    const rows = await this.db.query.contractors.findMany({
      where: and(eq(contractors.organizationId, orgId), isNull(contractors.archivedAt), ...(includeInactive ? [] : [eq(contractors.active, true)])),
      orderBy: [asc(contractors.name)],
    });
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [inv, eng] = await Promise.all([
      this.db
        .select({
          contractorId: expenses.contractorId,
          invoiced: sql<number>`coalesce(sum(case when ${expenses.kind} = 'refund' then -${expenses.amount} else ${expenses.amount} end), 0)::float`,
          unpaid: sql<number>`coalesce(sum(case when ${expenses.paidAt} is null and ${expenses.kind} = 'expense' then ${expenses.amount} else 0 end), 0)::float`,
          count: sql<number>`count(*)::int`,
        })
        .from(expenses)
        .where(and(inArray(expenses.contractorId, ids), isNull(expenses.archivedAt), sql`${expenses.approvalStatus} <> 'rejected'`))
        .groupBy(expenses.contractorId),
      this.db.select({ contractorId: projectContractors.contractorId, n: sql<number>`count(*)::int` }).from(projectContractors).where(inArray(projectContractors.contractorId, ids)).groupBy(projectContractors.contractorId),
    ]);
    const invBy = new Map(inv.map((i) => [i.contractorId, i]));
    const engBy = new Map(eng.map((e) => [e.contractorId, e.n]));
    return rows.map((r) => ({ ...shape(r), invoiced: round2(invBy.get(r.id)?.invoiced ?? 0), unpaid: round2(invBy.get(r.id)?.unpaid ?? 0), invoiceCount: invBy.get(r.id)?.count ?? 0, projectCount: engBy.get(r.id) ?? 0 }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.contractors.findFirst({ where: and(eq(contractors.id, id), eq(contractors.organizationId, orgId), isNull(contractors.archivedAt)) });
    if (!row) throw new NotFoundException("Freelancer not found");
    const [engagements, invoices] = await Promise.all([
      this.db.query.projectContractors.findMany({ where: eq(projectContractors.contractorId, id), with: { project: { columns: { id: true, name: true, color: true, status: true } } }, orderBy: [desc(projectContractors.createdAt)] }),
      this.invoicesFor(orgId, { contractorId: id }),
    ]);
    return { ...shape(row), engagements: engagements.map(shapeEngagement), invoices };
  }

  async create(orgId: string, actor: Actor, dto: ContractorDto) {
    if (!dto.name?.trim()) throw new BadRequestException("Name is required");
    const [row] = await this.db
      .insert(contractors)
      .values({ organizationId: orgId, createdById: actor.userId, ...clean(dto), name: dto.name.trim().slice(0, 255), currency: (dto.currency ?? "USD").toUpperCase() })
      .returning();
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "contractor", entityId: row!.id, action: "created", changes: [{ field: "name", from: null, to: row!.name }] });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, actor: Actor, id: string, dto: ContractorDto) {
    await this.get(orgId, id);
    const patch: Record<string, unknown> = { ...clean(dto), updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim().slice(0, 255);
    if (dto.currency !== undefined) patch.currency = dto.currency.toUpperCase();
    if (dto.active !== undefined) patch.active = dto.active;
    await this.db.update(contractors).set(patch).where(eq(contractors.id, id));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "contractor", entityId: id, action: "updated" });
    return this.get(orgId, id);
  }

  async archive(orgId: string, actor: Actor, id: string) {
    await this.get(orgId, id);
    await this.db.update(contractors).set({ archivedAt: new Date(), active: false }).where(eq(contractors.id, id));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "contractor", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /* ---------------- engagements ---------------- */

  async forProject(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true, currency: true } });
    if (!project) throw new NotFoundException("Project not found");
    const [engagements, invoices, cats] = await Promise.all([
      this.db.query.projectContractors.findMany({ where: eq(projectContractors.projectId, projectId), with: { contractor: true }, orderBy: [asc(projectContractors.createdAt)] }),
      this.invoicesFor(orgId, { projectId }),
      this.expensesService.categorySettings(orgId),
    ]);
    const catDefault = cats.find((c) => c.name === CATEGORY)?.markupPct ?? 0;
    const byContractor = new Map<string, typeof invoices>();
    for (const i of invoices) {
      if (!i.contractorId) continue;
      const l = byContractor.get(i.contractorId) ?? [];
      l.push(i);
      byContractor.set(i.contractorId, l);
    }
    const rows = engagements.map((e) => {
      const list = byContractor.get(e.contractorId) ?? [];
      const signed = (i: (typeof list)[number]) => (i.kind === "refund" ? -i.amount : i.amount);
      const invoiced = round2(list.filter((i) => i.approvalStatus !== "rejected").reduce((a, i) => a + signed(i), 0));
      const unpaid = round2(list.filter((i) => i.approvalStatus !== "rejected" && !i.paidAt && i.kind === "expense").reduce((a, i) => a + i.amount, 0));
      const billable = round2(list.filter((i) => i.approvalStatus === "approved" && i.billable && !i.personal).reduce((a, i) => a + signed(i) * (1 + (i.markupPct ?? e.markupPct ?? catDefault) / 100), 0));
      return { ...shapeEngagement(e), contractor: shape(e.contractor), invoiced, unpaid, billable, invoices: list };
    });
    const totals = {
      invoiced: round2(rows.reduce((a, r) => a + r.invoiced, 0)),
      unpaid: round2(rows.reduce((a, r) => a + r.unpaid, 0)),
      billable: round2(rows.reduce((a, r) => a + r.billable, 0)),
      pendingApproval: invoices.filter((i) => i.approvalStatus === "pending").length,
      currency: project.currency,
      categoryMarkupPct: catDefault,
    };
    return { engagements: rows, totals };
  }

  async engage(orgId: string, actor: Actor, projectId: string, dto: EngageDto) {
    if (!(await this.canManage(orgId, actor, projectId))) throw new ForbiddenException("Only a project manager can engage a freelancer");
    let contractorId = dto.contractorId ?? null;
    if (!contractorId) {
      if (!dto.name?.trim()) throw new BadRequestException("Pick a freelancer or give a name");
      const created = await this.create(orgId, actor, { name: dto.name, email: dto.email ?? null, role: dto.role ?? null });
      contractorId = created.id;
    } else {
      await this.get(orgId, contractorId);
    }
    const existing = await this.db.query.projectContractors.findFirst({ where: and(eq(projectContractors.projectId, projectId), eq(projectContractors.contractorId, contractorId)) });
    if (existing) throw new BadRequestException("Already engaged on this project");
    const [row] = await this.db
      .insert(projectContractors)
      .values({ organizationId: orgId, projectId, contractorId, createdById: actor.userId, role: dto.role?.trim() || null, agreedAmount: dto.agreedAmount ?? null, agreedRate: dto.agreedRate ?? null, markupPct: dto.markupPct ?? null, notes: dto.notes?.trim() || null })
      .returning();
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "project", entityId: projectId, action: "contractor_engaged", changes: [{ field: "contractor", from: null, to: contractorId }] });
    return { id: row!.id };
  }

  async updateEngagement(orgId: string, actor: Actor, projectId: string, id: string, dto: EngageDto) {
    if (!(await this.canManage(orgId, actor, projectId))) throw new ForbiddenException("Only a project manager can change an engagement");
    const row = await this.db.query.projectContractors.findFirst({ where: and(eq(projectContractors.id, id), eq(projectContractors.projectId, projectId), eq(projectContractors.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Engagement not found");
    const patch: Record<string, unknown> = {};
    if (dto.role !== undefined) patch.role = dto.role?.trim() || null;
    if (dto.agreedAmount !== undefined) patch.agreedAmount = dto.agreedAmount;
    if (dto.agreedRate !== undefined) patch.agreedRate = dto.agreedRate;
    if (dto.markupPct !== undefined) patch.markupPct = dto.markupPct;
    if (dto.notes !== undefined) patch.notes = dto.notes?.trim() || null;
    await this.db.update(projectContractors).set(patch).where(eq(projectContractors.id, id));
    return { id };
  }

  async disengage(orgId: string, actor: Actor, projectId: string, id: string) {
    if (!(await this.canManage(orgId, actor, projectId))) throw new ForbiddenException("Only a project manager can remove a freelancer");
    const row = await this.db.query.projectContractors.findFirst({ where: and(eq(projectContractors.id, id), eq(projectContractors.projectId, projectId), eq(projectContractors.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Engagement not found");
    const [n] = await this.db.select({ c: sql<number>`count(*)::int` }).from(expenses).where(and(eq(expenses.projectId, projectId), eq(expenses.contractorId, row.contractorId), isNull(expenses.archivedAt)));
    if ((n?.c ?? 0) > 0) throw new BadRequestException("They have invoices on this project — the engagement stays for the record");
    await this.db.delete(projectContractors).where(eq(projectContractors.id, id));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "project", entityId: projectId, action: "contractor_removed", changes: [{ field: "contractor", from: row.contractorId, to: null }] });
    return { id, removed: true };
  }

  /* ---------------- invoices ---------------- */

  /**
   * Log an invoice a freelancer sent. It becomes an expense (category
   * "Contractors & freelancers") so it flows into project cost, re-billing
   * and the approval queue; an admin's / lead's entry is approved outright,
   * a member's waits.
   */
  async logInvoice(orgId: string, actor: Actor, contractorId: string, dto: ContractorInvoiceDto) {
    const c = await this.get(orgId, contractorId);
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)), columns: { id: true, name: true, leadId: true, companyId: true } });
    if (!project) throw new NotFoundException("Project not found");
    if (!(Number(dto.amount) > 0)) throw new BadRequestException("Amount must be greater than zero");
    // Engage on first invoice so the project page shows them.
    const eng = await this.db.query.projectContractors.findFirst({ where: and(eq(projectContractors.projectId, project.id), eq(projectContractors.contractorId, contractorId)) });
    if (!eng) await this.db.insert(projectContractors).values({ organizationId: orgId, projectId: project.id, contractorId, createdById: actor.userId, role: c.role });
    const manager = this.isAdmin(actor) || project.leadId === actor.userId;
    const ref = dto.ref?.trim().slice(0, 64) || null;
    if (ref) {
      const dup = await this.db.query.expenses.findFirst({ where: and(eq(expenses.contractorId, contractorId), eq(expenses.contractorInvoiceRef, ref), isNull(expenses.archivedAt)), columns: { id: true } });
      if (dup) throw new BadRequestException(`Invoice ${ref} from ${c.name} is already logged`);
    }
    const now = new Date();
    const [row] = await this.db
      .insert(expenses)
      .values({
        organizationId: orgId,
        createdById: actor.userId,
        date: dto.date ? new Date(dto.date) : now,
        vendor: c.company || c.name,
        description: dto.description?.trim() || `Invoice${ref ? ` ${ref}` : ""} from ${c.name}`,
        amount: round2(Number(dto.amount)),
        currency: (dto.currency ?? c.currency ?? "USD").toUpperCase(),
        kind: "expense",
        category: CATEGORY,
        projectId: project.id,
        companyId: project.companyId ?? null,
        billable: dto.billable ?? true,
        personal: false,
        receiptUrl: dto.receiptUrl?.trim() || null,
        markupPct: dto.markupPct ?? eng?.markupPct ?? null,
        markupNote: dto.markupPct != null ? "Agreed with the freelancer's engagement" : eng?.markupPct != null ? "Engagement markup" : null,
        contractorId,
        contractorInvoiceRef: ref,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        paidAt: dto.paid ? now : null,
        approvalStatus: manager ? "approved" : "pending",
        submittedAt: now,
        decidedAt: manager ? now : null,
        decidedById: manager ? actor.userId : null,
        source: "manual",
      })
      .returning();
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "expense", entityId: row!.id, action: "contractor_invoice_logged", changes: [{ field: "amount", from: null, to: row!.amount }, { field: "contractor", from: null, to: c.name }] });
    if (!manager) await this.expensesService.askApproversFor(orgId, row!.id);
    return this.expensesService.get(orgId, row!.id);
  }

  async markPaid(orgId: string, actor: Actor, expenseId: string, dto: { paid: boolean; paidAt?: string | null; reference?: string | null }) {
    const e = await this.db.query.expenses.findFirst({ where: and(eq(expenses.id, expenseId), eq(expenses.organizationId, orgId), isNull(expenses.archivedAt)) });
    if (!e) throw new NotFoundException("Invoice not found");
    if (!e.contractorId) throw new BadRequestException("Only a freelancer invoice has a paid state");
    if (!(await this.canManage(orgId, actor, e.projectId ?? ""))) throw new ForbiddenException("Only a project manager can mark it paid");
    await this.db
      .update(expenses)
      .set({ paidAt: dto.paid ? (dto.paidAt ? new Date(dto.paidAt) : new Date()) : null, paidReference: dto.paid ? dto.reference?.trim() || null : null, updatedAt: new Date() })
      .where(eq(expenses.id, expenseId));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "expense", entityId: expenseId, action: dto.paid ? "contractor_invoice_paid" : "contractor_invoice_unpaid" });
    return this.expensesService.get(orgId, expenseId);
  }

  private async invoicesFor(orgId: string, by: { contractorId?: string; projectId?: string }) {
    const f = [eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), sql`${expenses.contractorId} is not null`];
    if (by.contractorId) f.push(eq(expenses.contractorId, by.contractorId));
    if (by.projectId) f.push(eq(expenses.projectId, by.projectId));
    const rows = await this.db.query.expenses.findMany({
      where: and(...f),
      with: { project: { columns: { id: true, name: true } }, contractor: { columns: { id: true, name: true } }, invoice: { columns: { id: true, number: true } } },
      orderBy: [desc(expenses.date)],
      limit: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      contractorId: r.contractorId,
      contractor: r.contractor ? { id: r.contractor.id, name: r.contractor.name } : null,
      project: r.project ? { id: r.project.id, name: r.project.name } : null,
      projectId: r.projectId,
      ref: r.contractorInvoiceRef,
      description: r.description,
      amount: r.amount,
      currency: r.currency,
      kind: r.kind,
      date: r.date,
      dueDate: r.dueDate,
      paidAt: r.paidAt,
      paidReference: r.paidReference,
      overdue: !r.paidAt && Boolean(r.dueDate && r.dueDate < new Date()),
      billable: r.billable,
      personal: r.personal,
      markupPct: r.markupPct,
      approvalStatus: r.approvalStatus,
      receiptUrl: r.receiptUrl,
      invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.number } : null,
    }));
  }
}

function clean(dto: ContractorDto) {
  const out: Record<string, unknown> = {};
  if (dto.email !== undefined) out.email = dto.email?.trim() || null;
  if (dto.phone !== undefined) out.phone = dto.phone?.trim() || null;
  if (dto.company !== undefined) out.company = dto.company?.trim() || null;
  if (dto.role !== undefined) out.role = dto.role?.trim() || null;
  if (dto.defaultRate !== undefined) out.defaultRate = dto.defaultRate;
  if (dto.notes !== undefined) out.notes = dto.notes?.trim() || null;
  return out;
}
function shape(r: typeof contractors.$inferSelect) {
  return { id: r.id, name: r.name, email: r.email, phone: r.phone, company: r.company, role: r.role, defaultRate: r.defaultRate, currency: r.currency, notes: r.notes, active: r.active, createdAt: r.createdAt };
}
function shapeEngagement(e: typeof projectContractors.$inferSelect & { project?: { id: string; name: string; color: string; status: string } | null }) {
  return { id: e.id, projectId: e.projectId, contractorId: e.contractorId, role: e.role, agreedAmount: e.agreedAmount, agreedRate: e.agreedRate, markupPct: e.markupPct, notes: e.notes, createdAt: e.createdAt, project: e.project ? { id: e.project.id, name: e.project.name, color: e.project.color, status: e.project.status } : undefined };
}
