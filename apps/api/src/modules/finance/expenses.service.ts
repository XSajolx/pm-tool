import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, expenseImports, expenseRules, expenses, memberships, organizations, projects, users, type ExpenseCategory } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService, pendingApproval } from "../notifications/notifications.service.js";
import { parseStatement, type ParsedRow } from "./statement-csv.js";
import { InvoicesService } from "./invoices.service.js";

export const CATEGORIES = [
  "Software & subscriptions",
  "Contractors & freelancers",
  "Advertising & marketing",
  "Hosting & domains",
  "Equipment",
  "Office & supplies",
  "Travel",
  "Meals & entertainment",
  "Professional services",
  "Bank & payment fees",
  "Insurance",
  "Rent & utilities",
  "Education & training",
  "Taxes & licences",
  "Salaries & benefits",
  "Print & production",
  "Stock assets",
  "Other",
] as const;

/** Row 134: the built-in list with a sensible default markup each (0 unless it is something you resell). */
const DEFAULT_MARKUP: Record<string, number> = { "Print & production": 10, "Stock assets": 15, "Contractors & freelancers": 10 };
export const defaultCategories = (): ExpenseCategory[] => CATEGORIES.map((name) => ({ name, markupPct: DEFAULT_MARKUP[name] ?? 0, active: true }));

/** Vendor hints that categorise obvious things before any user rule exists. */
const BUILTIN_HINTS: [RegExp, string][] = [
  [/adobe|figma|notion|slack|zoom|google\s*(workspace|gsuite)|microsoft|github|atlassian|jira|canva|dropbox|1password|openai|anthropic|chatgpt|midjourney|loom|calendly|hubspot|mailchimp|zapier|clickup|asana|linear/i, "Software & subscriptions"],
  [/aws|amazon web|digitalocean|vercel|netlify|cloudflare|godaddy|namecheap|hetzner|linode|heroku|supabase|render\.com|hostinger/i, "Hosting & domains"],
  [/facebook|meta\s*ads|google\s*ads|linkedin|twitter|x corp|tiktok|ads?\b/i, "Advertising & marketing"],
  [/upwork|fiverr|toptal|freelancer|contractor/i, "Contractors & freelancers"],
  [/uber|lyft|airline|airways|delta|united|emirates|hotel|marriott|hilton|airbnb|booking\.com|train|rail|taxi|fuel|petrol|shell|bp\b/i, "Travel"],
  [/starbucks|cafe|coffee|restaurant|pizza|burger|doordash|uber\s*eats|deliveroo|grubhub|mcdonald/i, "Meals & entertainment"],
  [/apple\.com|apple store|best buy|dell|lenovo|logitech|b&h|newegg/i, "Equipment"],
  [/staples|office depot|officeworks|ikea/i, "Office & supplies"],
  [/stripe|paypal|wise|payoneer|bank fee|service fee|fx fee|interest/i, "Bank & payment fees"],
  [/insurance|hiscox|next insurance/i, "Insurance"],
  [/wework|regus|electric|power|water|internet|comcast|verizon|at&t|t-mobile/i, "Rent & utilities"],
  [/udemy|coursera|course|training|conference|ticket/i, "Education & training"],
  [/irs|hmrc|tax|licen[cs]e|registration/i, "Taxes & licences"],
  [/gusto|adp|payroll|deel|remote\.com/i, "Salaries & benefits"],
  [/lawyer|attorney|legal|accountant|cpa|bookkeep/i, "Professional services"],
];

export interface ExpenseDto {
  date?: string;
  vendor?: string;
  description?: string | null;
  amount?: number;
  currency?: string;
  kind?: "expense" | "refund";
  category?: string | null;
  projectId?: string | null;
  companyId?: string | null;
  billable?: boolean;
  personal?: boolean;
  receiptUrl?: string | null;
  notes?: string | null;
  account?: string | null;
  reference?: string | null;
}

export interface RuleDto {
  match: string;
  category?: string | null;
  projectId?: string | null;
  billable?: boolean | null;
  personal?: boolean | null;
}

export interface ImportRowInput {
  date: string | null;
  vendor: string;
  description?: string | null;
  amount: number;
  kind?: "expense" | "refund";
  currency?: string | null;
  reference?: string | null;
  category?: string | null;
  projectId?: string | null;
  billable?: boolean;
  personal?: boolean;
  skip?: boolean;
}

/** Fields an approved expense can no longer change (row 133) — corrections are adjustments. */
const LOCKED_FIELDS = ["date", "vendor", "amount", "currency", "kind", "category", "projectId", "companyId", "billable", "personal"] as const;

@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly invoicesService: InvoicesService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Row 133: the inbox approval card's Approve / Reject buttons land here. */
  onModuleInit() {
    this.notifications.registerApproval("expense", (d) => this.decide(d.orgId, { userId: d.userId, role: d.role }, d.entityId, d.approve, d.note));
  }

  /** Active category names — the list every dropdown uses. */
  async categories(orgId: string) {
    return (await this.categorySettings(orgId)).filter((c) => c.active).map((c) => c.name);
  }

  /* ---------------- row 134: categories with default markup ---------------- */

  async categorySettings(orgId: string): Promise<ExpenseCategory[]> {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { expenseCategories: true } });
    if (org?.expenseCategories?.length) return org.expenseCategories;
    return defaultCategories();
  }

  async saveCategorySettings(orgId: string, userId: string, list: ExpenseCategory[]) {
    const seen = new Set<string>();
    const clean = list
      .map((c) => ({ name: c.name.trim().slice(0, 64), markupPct: Math.min(500, Math.max(0, Number(c.markupPct) || 0)), active: c.active !== false }))
      .filter((c) => c.name && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()));
    if (!clean.length) throw new BadRequestException("Keep at least one category");
    const before = await this.categorySettings(orgId);
    await this.db.update(organizations).set({ expenseCategories: clean, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    const changed = clean.filter((c) => {
      const b = before.find((x) => x.name === c.name);
      return !b || b.markupPct !== c.markupPct || b.active !== c.active;
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "expense_categories_updated", changes: changed.slice(0, 20).map((c) => ({ field: c.name, from: before.find((x) => x.name === c.name)?.markupPct ?? null, to: c.markupPct })) });
    return clean;
  }

  /** Effective markup for an expense: its own override, else its category default, else 0. */
  private markupFor(e: { category: string | null; markupPct: number | null }, cats: ExpenseCategory[]) {
    if (e.markupPct != null) return { pct: e.markupPct, source: "override" as const };
    const c = e.category ? cats.find((x) => x.name === e.category) : undefined;
    return { pct: c?.markupPct ?? 0, source: c ? ("category" as const) : ("none" as const) };
  }

  /** A manager overrides the default markup on one expense, saying why; null goes back to the default. */
  async setMarkup(orgId: string, actor: { userId: string; role: string }, id: string, dto: { markupPct: number | null; note?: string | null }) {
    const e = await this.get(orgId, id);
    if (!(await this.approverIds(orgId, e.projectId)).has(actor.userId)) throw new ForbiddenException("Only a project manager can change the markup");
    if (e.invoiceId) throw new BadRequestException("This expense is already on an invoice");
    if (dto.markupPct != null && !dto.note?.trim()) throw new BadRequestException("Say why this expense gets a different markup");
    const pct = dto.markupPct == null ? null : Math.min(500, Math.max(0, dto.markupPct));
    await this.db.update(expenses).set({ markupPct: pct, markupNote: pct == null ? null : dto.note!.trim(), updatedAt: new Date() }).where(eq(expenses.id, id));
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "expense", entityId: id, action: "markup_overridden", changes: [{ field: "markupPct", from: e.markupPct, to: pct }, ...(pct != null ? [{ field: "note", from: null, to: dto.note!.trim() }] : [])] });
    return this.get(orgId, id);
  }

  /* ---------------- read ---------------- */

  async list(orgId: string, opts: { filter?: string; projectId?: string; companyId?: string; from?: string; to?: string; importId?: string; q?: string; createdById?: string } = {}) {
    const f = [eq(expenses.organizationId, orgId), isNull(expenses.archivedAt)];
    if (opts.createdById) f.push(eq(expenses.createdById, opts.createdById));
    if (opts.projectId) f.push(eq(expenses.projectId, opts.projectId));
    if (opts.companyId) f.push(eq(expenses.companyId, opts.companyId));
    if (opts.importId) f.push(eq(expenses.importId, opts.importId));
    if (opts.from) f.push(gte(expenses.date, new Date(opts.from)));
    if (opts.to) f.push(lte(expenses.date, new Date(opts.to)));
    if (opts.q) f.push(sql`(${expenses.vendor} ilike ${"%" + opts.q + "%"} or ${expenses.description} ilike ${"%" + opts.q + "%"})`);
    switch (opts.filter) {
      case "uncategorised":
        f.push(isNull(expenses.category), eq(expenses.personal, false));
        break;
      case "billable":
        f.push(eq(expenses.billable, true), isNull(expenses.invoiceId), eq(expenses.personal, false));
        break;
      case "billed":
        f.push(sql`${expenses.invoiceId} is not null`);
        break;
      case "personal":
        f.push(eq(expenses.personal, true));
        break;
      case "refunds":
        f.push(eq(expenses.kind, "refund"));
        break;
      case "imported":
        f.push(eq(expenses.source, "import"));
        break;
      case "pending":
        f.push(eq(expenses.approvalStatus, "pending"));
        break;
      case "rejected":
        f.push(eq(expenses.approvalStatus, "rejected"));
        break;
    }
    const rows = await this.db.query.expenses.findMany({
      where: and(...f),
      with: { project: { columns: { id: true, name: true } }, company: { columns: { id: true, name: true } }, invoice: { columns: { id: true, number: true } }, createdBy: { columns: { id: true, name: true } }, decidedBy: { columns: { id: true, name: true } } },
      orderBy: [desc(expenses.date), desc(expenses.createdAt)],
      limit: 1000,
    });
    return rows.map(shape);
  }

  async summary(orgId: string) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const base = and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.personal, false));
    const [month] = await this.db
      .select({ n: sql<number>`coalesce(sum(case when ${expenses.kind} = 'expense' then ${expenses.amount} else -${expenses.amount} end), 0)::float` })
      .from(expenses)
      .where(and(base, gte(expenses.date, monthStart)));
    const [uncat] = await this.db.select({ n: sql<number>`count(*)::int` }).from(expenses).where(and(base, isNull(expenses.category)));
    const [bill] = await this.db
      .select({ n: sql<number>`coalesce(sum(${expenses.amount}), 0)::float`, c: sql<number>`count(*)::int` })
      .from(expenses)
      .where(and(base, eq(expenses.billable, true), isNull(expenses.invoiceId), eq(expenses.kind, "expense"), eq(expenses.approvalStatus, "approved")));
    const [pending] = await this.db.select({ c: sql<number>`count(*)::int`, n: sql<number>`coalesce(sum(${expenses.amount}), 0)::float` }).from(expenses).where(and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.approvalStatus, "pending")));
    const [personal] = await this.db.select({ n: sql<number>`coalesce(sum(${expenses.amount}), 0)::float` }).from(expenses).where(and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.personal, true), gte(expenses.date, monthStart)));
    return { thisMonth: round2(month?.n ?? 0), uncategorised: uncat?.n ?? 0, unbilledBillable: round2(bill?.n ?? 0), unbilledCount: bill?.c ?? 0, personalThisMonth: round2(personal?.n ?? 0), pendingCount: pending?.c ?? 0, pendingAmount: round2(pending?.n ?? 0) };
  }

  async get(orgId: string, id: string, ownerId?: string) {
    const row = await this.db.query.expenses.findFirst({
      where: and(eq(expenses.id, id), eq(expenses.organizationId, orgId)),
      with: {
        project: { columns: { id: true, name: true } },
        company: { columns: { id: true, name: true } },
        invoice: { columns: { id: true, number: true } },
        createdBy: { columns: { id: true, name: true } },
        decidedBy: { columns: { id: true, name: true } },
        adjustments: { columns: { id: true, amount: true, kind: true, description: true, createdAt: true }, orderBy: [asc(expenses.createdAt)] },
      },
    });
    if (!row || (ownerId && row.createdById !== ownerId)) throw new NotFoundException("Expense not found");
    return { ...shape(row), adjustments: row.adjustments.map((a) => ({ id: a.id, amount: a.amount, kind: a.kind, description: a.description, createdAt: a.createdAt })) };
  }

  /* ---------------- write ---------------- */

  async create(orgId: string, userId: string, dto: ExpenseDto, role = "owner") {
    await this.assertLinks(orgId, dto);
    if (!dto.vendor?.trim()) throw new BadRequestException("Vendor is required");
    if (!(Number(dto.amount) > 0)) throw new BadRequestException("Amount must be greater than zero");
    const guess = dto.category === undefined ? await this.suggest(orgId, dto.vendor, dto.description ?? "") : null;
    // Row 133: what a member logs waits for a project manager; what an admin logs is approved by definition.
    const needsApproval = role === "member";
    const [row] = await this.db
      .insert(expenses)
      .values({
        organizationId: orgId,
        createdById: userId,
        approvalStatus: needsApproval ? "pending" : "approved",
        submittedAt: needsApproval ? new Date() : null,
        decidedAt: needsApproval ? null : new Date(),
        decidedById: needsApproval ? null : userId,
        date: dto.date ? new Date(dto.date) : new Date(),
        vendor: dto.vendor.trim().slice(0, 255),
        description: dto.description?.trim() || null,
        amount: round2(Number(dto.amount)),
        currency: (dto.currency ?? "USD").toUpperCase(),
        kind: dto.kind ?? "expense",
        category: dto.category !== undefined ? dto.category : (guess?.category ?? null),
        projectId: dto.projectId ?? guess?.projectId ?? null,
        companyId: dto.companyId ?? null,
        billable: dto.billable ?? guess?.billable ?? false,
        personal: dto.personal ?? guess?.personal ?? false,
        receiptUrl: dto.receiptUrl?.trim() || null,
        notes: dto.notes?.trim() || null,
        account: dto.account?.trim() || null,
        reference: dto.reference?.trim() || null,
        source: "manual",
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "expense", entityId: row!.id, action: "created", changes: [{ field: "amount", from: null, to: row!.amount }] });
    if (needsApproval) await this.askApprovers(orgId, row!.id);
    return this.get(orgId, row!.id);
  }

  /* ---------------- row 133: approval queue ---------------- */

  /** Who can approve: owners / admins, plus the lead of the expense's project. */
  private async approverIds(orgId: string, projectId: string | null) {
    const admins = await this.db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.organizationId, orgId), inArray(memberships.role, ["owner", "admin"])));
    const ids = new Set(admins.map((a) => a.userId));
    if (projectId) {
      const p = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { leadId: true } });
      if (p?.leadId) ids.add(p.leadId);
    }
    return ids;
  }

  /** Also used by row 135 when a member logs a freelancer invoice. */
  async askApproversFor(orgId: string, id: string) {
    return this.askApprovers(orgId, id);
  }

  private async askApprovers(orgId: string, id: string) {
    const e = await this.get(orgId, id);
    const [who] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, e.createdBy?.id ?? ""));
    for (const approver of await this.approverIds(orgId, e.projectId)) {
      if (approver === e.createdBy?.id) continue;
      await this.notifications.notifyDirect({
        orgId,
        receiverId: approver,
        actorId: e.createdBy?.id ?? null,
        entityType: "expense",
        entityId: id,
        verb: "expense_submitted",
        title: `Expense to approve: ${who?.name ?? "Someone"} · ${e.currency} ${e.amount.toFixed(2)} at ${e.vendor}`,
        body: [e.project?.name, e.category, e.description, e.billable ? "billable" : null].filter(Boolean).join(" · "),
        data: { expenseId: id, approval: pendingApproval("expense"), link: "/finance/expenses?filter=pending" },
      });
    }
  }

  /** The queue: pending expenses an approver can act on (admins: all; a project lead: their projects). */
  async queue(orgId: string, actor: { userId: string; role: string }) {
    const admin = actor.role === "owner" || actor.role === "admin";
    const f = [eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.approvalStatus, "pending")];
    if (!admin) {
      const led = await this.db.select({ id: projects.id }).from(projects).where(and(eq(projects.organizationId, orgId), eq(projects.leadId, actor.userId)));
      if (!led.length) return [];
      f.push(inArray(expenses.projectId, led.map((p) => p.id)));
    }
    const rows = await this.db.query.expenses.findMany({
      where: and(...f),
      with: { project: { columns: { id: true, name: true } }, company: { columns: { id: true, name: true } }, invoice: { columns: { id: true, number: true } }, createdBy: { columns: { id: true, name: true } }, decidedBy: { columns: { id: true, name: true } } },
      orderBy: [asc(expenses.submittedAt)],
      limit: 300,
    });
    return rows.map(shape);
  }

  async decide(orgId: string, actor: { userId: string; role: string }, id: string, approve: boolean, note?: string | null) {
    const e = await this.get(orgId, id);
    if (e.approvalStatus !== "pending") throw new BadRequestException(`This expense was already ${e.approvalStatus}`);
    const allowed = await this.approverIds(orgId, e.projectId);
    if (!allowed.has(actor.userId)) throw new ForbiddenException("Only a project manager can approve expenses");
    if (e.createdBy?.id === actor.userId && actor.role === "member") throw new ForbiddenException("You cannot approve your own expense");
    if (!approve && !note?.trim()) throw new BadRequestException("Say why it was rejected so it can be fixed");
    const now = new Date();
    await this.db
      .update(expenses)
      .set({ approvalStatus: approve ? "approved" : "rejected", decidedAt: now, decidedById: actor.userId, decisionNote: note?.trim() || null, updatedAt: now })
      .where(eq(expenses.id, id));
    await this.notifications.resolveApproval("expense", id, approve ? "approved" : "rejected", note, actor.userId);
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "expense", entityId: id, action: approve ? "approved" : "rejected", changes: [{ field: "approvalStatus", from: "pending", to: approve ? "approved" : "rejected" }, ...(note?.trim() ? [{ field: "note", from: null, to: note.trim() }] : [])] });
    if (e.createdBy && e.createdBy.id !== actor.userId) {
      await this.notifications.notifyDirect({
        orgId,
        receiverId: e.createdBy.id,
        actorId: actor.userId,
        entityType: "expense",
        entityId: id,
        verb: approve ? "expense_approved" : "expense_rejected",
        title: `${approve ? "Approved" : "Rejected"}: ${e.currency} ${e.amount.toFixed(2)} at ${e.vendor}`,
        body: note?.trim() || (approve ? "It can now be billed." : null),
        data: { expenseId: id, link: "/finance/expenses" },
      });
    }
    return this.get(orgId, id);
  }

  /** A rejected expense, fixed, goes back in the queue. */
  async resubmit(orgId: string, userId: string, id: string, ownerId?: string) {
    const e = await this.get(orgId, id, ownerId);
    if (e.approvalStatus !== "rejected") throw new BadRequestException("Only a rejected expense can be resubmitted");
    await this.db.update(expenses).set({ approvalStatus: "pending", submittedAt: new Date(), decidedAt: null, decidedById: null, decisionNote: null, updatedAt: new Date() }).where(eq(expenses.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "expense", entityId: id, action: "resubmitted" });
    await this.askApprovers(orgId, id);
    return this.get(orgId, id);
  }

  /**
   * An approved expense never changes; a correction is a new, already-approved
   * row for the difference (a refund when the amount goes down) that points
   * back at the original, so the trail stays honest and the invoice math
   * still adds up.
   */
  async adjust(orgId: string, actor: { userId: string; role: string }, id: string, dto: { amount: number; note: string }) {
    const e = await this.get(orgId, id);
    if (e.approvalStatus !== "approved") throw new BadRequestException("Only an approved expense needs an adjustment — edit it instead");
    if (!(await this.approverIds(orgId, e.projectId)).has(actor.userId)) throw new ForbiddenException("Only a project manager can adjust an approved expense");
    const target = round2(Number(dto.amount));
    if (!(target >= 0)) throw new BadRequestException("The corrected amount must be zero or more");
    const current = round2(e.amount + e.adjustments.reduce((a, x) => a + (x.kind === "refund" ? -x.amount : x.amount), 0));
    const diff = round2(target - current);
    if (Math.abs(diff) < 0.005) throw new BadRequestException("That is already the amount");
    if (!dto.note?.trim()) throw new BadRequestException("Say what the correction is for");
    const now = new Date();
    const [row] = await this.db
      .insert(expenses)
      .values({
        organizationId: orgId,
        createdById: actor.userId,
        date: e.date,
        vendor: e.vendor,
        description: `Adjustment to ${e.vendor} (${e.date.toISOString().slice(0, 10)}): ${dto.note.trim()}`,
        amount: Math.abs(diff),
        currency: e.currency,
        kind: diff < 0 ? "refund" : "expense",
        category: e.category,
        projectId: e.projectId,
        companyId: e.companyId,
        billable: e.billable,
        personal: e.personal,
        notes: dto.note.trim(),
        approvalStatus: "approved",
        decidedAt: now,
        decidedById: actor.userId,
        adjustsExpenseId: e.id,
        source: "manual",
      })
      .returning();
    await this.activity.record({ orgId, actorId: actor.userId, entityType: "expense", entityId: e.id, action: "adjusted", changes: [{ field: "amount", from: current, to: target }, { field: "note", from: null, to: dto.note.trim() }] });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: ExpenseDto & { rememberVendor?: boolean; applyToSimilar?: boolean }, ownerId?: string) {
    const before = await this.get(orgId, id, ownerId);
    if (before.invoiceId && (dto.amount !== undefined || dto.billable === false)) throw new BadRequestException("This expense is on an invoice — remove it from the invoice first");
    // Row 133: approved = locked. Category / project may still be tidied by an approver; money fields need an adjustment.
    if (before.approvalStatus === "approved" && before.source === "manual" && before.submittedAt) {
      const touched = LOCKED_FIELDS.filter((k) => dto[k] !== undefined && dto[k] !== (before as Record<string, unknown>)[k]);
      const money = touched.filter((k) => ["date", "vendor", "amount", "currency", "kind", "billable", "personal"].includes(k));
      if (money.length) throw new BadRequestException("This expense is approved and locked — record an adjustment instead");
    }
    await this.assertLinks(orgId, dto);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.date !== undefined) patch.date = new Date(dto.date);
    if (dto.vendor !== undefined) patch.vendor = dto.vendor.trim().slice(0, 255) || before.vendor;
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
    if (dto.amount !== undefined) {
      if (!(Number(dto.amount) > 0)) throw new BadRequestException("Amount must be greater than zero");
      patch.amount = round2(Number(dto.amount));
    }
    if (dto.currency !== undefined) patch.currency = dto.currency.toUpperCase();
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.category !== undefined) patch.category = dto.category || null;
    for (const k of ["projectId", "companyId"] as const) if (dto[k] !== undefined) patch[k] = dto[k];
    if (dto.billable !== undefined) patch.billable = dto.billable;
    if (dto.personal !== undefined) patch.personal = dto.personal;
    if (dto.receiptUrl !== undefined) patch.receiptUrl = dto.receiptUrl?.trim() || null;
    if (dto.notes !== undefined) patch.notes = dto.notes?.trim() || null;
    if (dto.account !== undefined) patch.account = dto.account?.trim() || null;
    await this.db.update(expenses).set(patch).where(eq(expenses.id, id));

    // "Remember this for <vendor>": upsert a rule and optionally re-file the vendor's other uncategorised rows.
    if (dto.rememberVendor) {
      const key = keyOf(before.vendor);
      if (key) {
        const existing = await this.db.query.expenseRules.findFirst({ where: and(eq(expenseRules.organizationId, orgId), sql`lower(${expenseRules.match}) = ${key.toLowerCase()}`) });
        const values = {
          category: dto.category !== undefined ? dto.category || null : before.category,
          projectId: dto.projectId !== undefined ? dto.projectId : before.projectId,
          billable: dto.billable !== undefined ? dto.billable : before.billable,
          personal: dto.personal !== undefined ? dto.personal : before.personal,
        };
        if (existing) await this.db.update(expenseRules).set(values).where(eq(expenseRules.id, existing.id));
        else await this.db.insert(expenseRules).values({ organizationId: orgId, createdById: userId, match: key, ...values });
        if (dto.applyToSimilar) {
          await this.db
            .update(expenses)
            .set({ category: values.category, projectId: values.projectId, billable: values.billable, personal: values.personal, updatedAt: new Date() })
            .where(and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), isNull(expenses.invoiceId), isNull(expenses.category), sql`lower(${expenses.vendor}) like ${"%" + key.toLowerCase() + "%"}`));
        }
      }
    }
    return this.get(orgId, id);
  }

  async remove(orgId: string, userId: string, id: string) {
    const e = await this.get(orgId, id);
    if (e.invoiceId) throw new BadRequestException("This expense is on an invoice — remove it from the invoice first");
    await this.db.update(expenses).set({ archivedAt: new Date() }).where(eq(expenses.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "expense", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /* ---------------- rules ---------------- */

  async rules(orgId: string) {
    const rows = await this.db.query.expenseRules.findMany({ where: eq(expenseRules.organizationId, orgId), with: { project: { columns: { id: true, name: true } } }, orderBy: [desc(expenseRules.hits), asc(expenseRules.match)] });
    return rows.map((r) => ({ id: r.id, match: r.match, category: r.category, projectId: r.projectId, project: r.project ? { id: r.project.id, name: r.project.name } : null, billable: r.billable, personal: r.personal, hits: r.hits, createdAt: r.createdAt }));
  }

  async createRule(orgId: string, userId: string, dto: RuleDto) {
    const match = dto.match.trim().slice(0, 255);
    if (match.length < 2) throw new BadRequestException("Match text is too short");
    if (dto.projectId) await this.assertLinks(orgId, { projectId: dto.projectId });
    const [row] = await this.db.insert(expenseRules).values({ organizationId: orgId, createdById: userId, match, category: dto.category || null, projectId: dto.projectId ?? null, billable: dto.billable ?? null, personal: dto.personal ?? null }).returning();
    return row!;
  }

  async removeRule(orgId: string, id: string) {
    await this.db.delete(expenseRules).where(and(eq(expenseRules.id, id), eq(expenseRules.organizationId, orgId)));
    return { id, removed: true };
  }

  /** Rules first (longest match wins), then built-in vendor hints. */
  private async suggest(orgId: string, vendor: string, description: string, ruleCache?: Awaited<ReturnType<ExpensesService["rules"]>>) {
    const rules = ruleCache ?? (await this.rules(orgId));
    const hay = `${vendor} ${description}`.toLowerCase();
    const hit = rules.filter((r) => hay.includes(r.match.toLowerCase())).sort((a, b) => b.match.length - a.match.length)[0];
    if (hit) return { category: hit.category, projectId: hit.projectId, billable: hit.billable ?? undefined, personal: hit.personal ?? undefined, ruleId: hit.id, via: "rule" as const };
    const builtin = BUILTIN_HINTS.find(([re]) => re.test(hay));
    if (builtin) return { category: builtin[1], projectId: null, billable: undefined, personal: undefined, ruleId: null, via: "hint" as const };
    return null;
  }

  /* ---------------- statement import ---------------- */

  /** Parse and enrich without writing anything: the user reviews, edits, unticks, then commits. */
  async preview(orgId: string, text: string) {
    if (!text?.trim()) throw new BadRequestException("The file is empty");
    if (text.length > 5_000_000) throw new BadRequestException("File is too large (5 MB max)");
    const parsed = parseStatement(text);
    if (!parsed.rows.length) throw new BadRequestException("No transactions found — is this a CSV export?");
    const rules = await this.rules(orgId);
    const existing = await this.db
      .select({ date: expenses.date, amount: expenses.amount, vendor: expenses.vendor, reference: expenses.reference })
      .from(expenses)
      .where(and(eq(expenses.organizationId, orgId), isNull(expenses.archivedAt)));
    const seen = new Set(existing.map((e) => dupKey(e.date.toISOString().slice(0, 10), e.amount, e.vendor)));
    const refs = new Set(existing.map((e) => e.reference).filter(Boolean));
    const inFile = new Set<string>();
    const rows = [];
    for (const r of parsed.rows) {
      const s = await this.suggest(orgId, r.vendor, r.description, rules);
      const key = r.date ? dupKey(r.date, r.amount, r.vendor) : null;
      const duplicate = Boolean((key && seen.has(key)) || (r.reference && refs.has(r.reference)));
      const duplicateInFile = Boolean(key && inFile.has(key));
      if (key) inFile.add(key);
      rows.push({
        ...r,
        category: s?.category ?? null,
        projectId: s?.projectId ?? null,
        billable: s?.billable ?? false,
        personal: s?.personal ?? false,
        suggestedBy: s?.via ?? null,
        duplicate,
        duplicateInFile,
        skip: duplicate || duplicateInFile || r.problems.length > 0 || r.kind === "refund",
      });
    }
    return { columns: parsed.columns, delimiter: parsed.delimiter, headerless: parsed.headerless, total: rows.length, duplicates: rows.filter((r) => r.duplicate || r.duplicateInFile).length, refunds: rows.filter((r) => r.kind === "refund").length, unreadable: rows.filter((r) => r.problems.length).length, rows };
  }

  async commit(orgId: string, userId: string, input: { filename: string; account?: string | null; rows: ImportRowInput[] }) {
    const rows = input.rows.filter((r) => !r.skip);
    if (!rows.length) throw new BadRequestException("Nothing selected to import");
    const bad = rows.find((r) => !r.date || Number.isNaN(new Date(r.date).getTime()) || !(Math.abs(Number(r.amount)) > 0));
    if (bad) throw new BadRequestException(`Row "${bad.vendor || "?"}" has no usable date or amount — untick it`);
    if (rows.length > 5000) throw new BadRequestException("Too many rows in one import (5,000 max)");
    const projectIds = new Set(rows.map((r) => r.projectId).filter((x): x is string => Boolean(x)));
    for (const pid of projectIds) await this.assertLinks(orgId, { projectId: pid });
    const rules = await this.rules(orgId);
    const importId = await this.db.transaction(async (tx) => {
      const [imp] = await tx.insert(expenseImports).values({ organizationId: orgId, createdById: userId, filename: input.filename.slice(0, 255), account: input.account?.trim().slice(0, 120) || null, rowCount: input.rows.length, importedCount: rows.length, skippedCount: input.rows.length - rows.length }).returning();
      const hits = new Map<string, number>();
      await tx.insert(expenses).values(
        rows.map((r) => {
          const hay = `${r.vendor} ${r.description ?? ""}`.toLowerCase();
          const rule = rules.filter((x) => hay.includes(x.match.toLowerCase())).sort((a, b) => b.match.length - a.match.length)[0];
          if (rule) hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1);
          return {
            organizationId: orgId,
            createdById: userId,
            importId: imp!.id,
            source: "import" as const,
            account: input.account?.trim().slice(0, 120) || null,
            date: new Date(r.date!),
            vendor: (r.vendor || "Unknown").trim().slice(0, 255),
            description: r.description?.trim() || null,
            amount: round2(Math.abs(Number(r.amount))),
            currency: (r.currency || "USD").toUpperCase().slice(0, 3),
            kind: r.kind ?? "expense",
            category: r.category || null,
            projectId: r.projectId ?? null,
            billable: Boolean(r.billable),
            personal: Boolean(r.personal),
            reference: r.reference?.trim().slice(0, 255) || null,
          };
        }),
      );
      for (const [ruleId, n] of hits) await tx.update(expenseRules).set({ hits: sql`${expenseRules.hits} + ${n}` }).where(eq(expenseRules.id, ruleId));
      return imp!.id;
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "expense", entityId: importId, action: "imported", changes: [{ field: "rows", from: null, to: String(rows.length) }] });
    return this.imports(orgId).then((list) => list.find((i) => i.id === importId)!);
  }

  async imports(orgId: string) {
    const rows = await this.db.query.expenseImports.findMany({ where: eq(expenseImports.organizationId, orgId), with: { createdBy: { columns: { id: true, name: true } } }, orderBy: [desc(expenseImports.createdAt)], limit: 50 });
    return rows.map((r) => ({ id: r.id, filename: r.filename, account: r.account, rowCount: r.rowCount, importedCount: r.importedCount, skippedCount: r.skippedCount, createdAt: r.createdAt, createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null }));
  }

  /** Undo a whole import (only rows not yet on an invoice go). */
  async undoImport(orgId: string, userId: string, importId: string) {
    const imp = await this.db.query.expenseImports.findFirst({ where: and(eq(expenseImports.id, importId), eq(expenseImports.organizationId, orgId)) });
    if (!imp) throw new NotFoundException("Import not found");
    const res = await this.db.update(expenses).set({ archivedAt: new Date() }).where(and(eq(expenses.importId, importId), isNull(expenses.archivedAt), isNull(expenses.invoiceId))).returning({ id: expenses.id });
    await this.activity.record({ orgId, actorId: userId, entityType: "expense", entityId: importId, action: "import_undone", changes: [{ field: "rows", from: String(imp.importedCount), to: String(imp.importedCount - res.length) }] });
    return { id: importId, removed: res.length };
  }

  /* ---------------- billing (row 160: "attach to an invoice as billable") ---------------- */

  /** Unbilled billable expenses that fit an invoice's project/company. */
  async billableFor(orgId: string, opts: { projectId?: string | null; companyId?: string | null }) {
    const f = [eq(expenses.organizationId, orgId), isNull(expenses.archivedAt), eq(expenses.billable, true), isNull(expenses.invoiceId), eq(expenses.personal, false), eq(expenses.kind, "expense"), eq(expenses.approvalStatus, "approved")];
    if (opts.projectId) f.push(eq(expenses.projectId, opts.projectId));
    else if (opts.companyId) f.push(eq(expenses.companyId, opts.companyId));
    const rows = await this.db.query.expenses.findMany({ where: and(...f), with: { project: { columns: { id: true, name: true } }, company: { columns: { id: true, name: true } }, invoice: { columns: { id: true, number: true } } }, orderBy: [asc(expenses.date)], limit: 200 });
    const cats = await this.categorySettings(orgId);
    return rows.map((r) => {
      const m = this.markupFor(r, cats);
      return { ...shape(r), effectiveMarkupPct: m.pct, markupSource: m.source, billAmount: round2(r.amount * (1 + m.pct / 100)) };
    });
  }

  async addToInvoice(orgId: string, userId: string, invoiceId: string, expenseIds: string[], markup: number | null = null) {
    const inv = await this.invoicesService.get(orgId, invoiceId);
    if (inv.status !== "draft") throw new BadRequestException("Expenses can only be added to a draft invoice");
    if (!expenseIds.length) throw new BadRequestException("Pick at least one expense");
    const rows = await this.db.query.expenses.findMany({ where: and(eq(expenses.organizationId, orgId), inArray(expenses.id, expenseIds), isNull(expenses.archivedAt)) });
    if (rows.length !== expenseIds.length) throw new BadRequestException("Some expenses were not found");
    const unapproved = rows.filter((r) => r.approvalStatus !== "approved");
    if (unapproved.length) throw new BadRequestException(`${unapproved.length} of those expense${unapproved.length === 1 ? " is" : "s are"} not approved yet`);
    const already = rows.filter((r) => r.invoiceId);
    if (already.length) throw new BadRequestException(`${already.length} of these are already on an invoice`);
    // Row 134: each expense carries its own markup (override, else category default) unless the caller forces one for all.
    const cats = await this.categorySettings(orgId);
    const pctOf = (r: (typeof rows)[number]) => (markup != null ? Math.min(500, Math.max(0, markup)) : this.markupFor(r, cats).pct);
    const items = [
      ...inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice })),
      ...rows.map((r) => ({ description: `Expense — ${r.vendor}${r.description ? `: ${r.description}` : ""} (${r.date.toISOString().slice(0, 10)})`, quantity: 1, unitPrice: round2(r.amount * (1 + pctOf(r) / 100)) })),
    ];
    await this.invoicesService.update(orgId, userId, invoiceId, { items });
    await this.db.update(expenses).set({ invoiceId, billable: true, updatedAt: new Date() }).where(inArray(expenses.id, expenseIds));
    await this.activity.record({ orgId, actorId: userId, entityType: "invoice", entityId: invoiceId, action: "expenses_added", changes: [{ field: "expenses", from: null, to: String(rows.length) }] });
    return this.invoicesService.get(orgId, invoiceId);
  }

  /** Taking an expense off a draft invoice removes the matching line and frees the expense. */
  async removeFromInvoice(orgId: string, userId: string, invoiceId: string, expenseId: string) {
    const inv = await this.invoicesService.get(orgId, invoiceId);
    if (inv.status !== "draft") throw new BadRequestException("Only a draft invoice can be changed");
    const e = await this.get(orgId, expenseId);
    if (e.invoiceId !== invoiceId) throw new BadRequestException("That expense is not on this invoice");
    // Lines are matched by the description we wrote (vendor + date), so a markup doesn't hide them.
    const marker = `Expense — ${e.vendor}`;
    const day = `(${e.date.toISOString().slice(0, 10)})`;
    let removed = false;
    const items = inv.items
      .filter((i) => {
        const hit = !removed && i.description.startsWith(marker) && i.description.endsWith(day);
        if (hit) removed = true;
        return !hit;
      })
      .map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice }));
    await this.invoicesService.update(orgId, userId, invoiceId, { items });
    await this.db.update(expenses).set({ invoiceId: null, updatedAt: new Date() }).where(eq(expenses.id, expenseId));
    return this.invoicesService.get(orgId, invoiceId);
  }

  /** Called when an invoice is voided/deleted so its expenses become billable again. */
  async releaseInvoice(invoiceId: string) {
    await this.db.update(expenses).set({ invoiceId: null, updatedAt: new Date() }).where(eq(expenses.invoiceId, invoiceId));
  }

  /* ---------------- helpers ---------------- */

  private async assertLinks(orgId: string, dto: { projectId?: string | null; companyId?: string | null }) {
    if (dto.projectId && !(await this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId), eq(projects.organizationId, orgId)) }))) throw new BadRequestException("Project not found in this organization");
    if (dto.companyId && !(await this.db.query.companies.findFirst({ where: and(eq(companies.id, dto.companyId), eq(companies.organizationId, orgId)) }))) throw new BadRequestException("Company not found in this organization");
  }
}

function dupKey(date: string, amount: number, vendor: string) {
  return `${date}|${round2(amount).toFixed(2)}|${keyOf(vendor).toLowerCase()}`;
}

/** The stable part of a vendor string: letters/digits, first ~24 chars. */
function keyOf(vendor: string) {
  return vendor.replace(/[^A-Za-z0-9 &.-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24).trim();
}

function shape(r: typeof expenses.$inferSelect & { project: { id: string; name: string } | null; company: { id: string; name: string } | null; invoice: { id: string; number: string } | null; createdBy?: { id: string; name: string } | null; decidedBy?: { id: string; name: string } | null }) {
  return {
    id: r.id,
    createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null,
    approvalStatus: r.approvalStatus,
    submittedAt: r.submittedAt,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy ? { id: r.decidedBy.id, name: r.decidedBy.name } : null,
    decisionNote: r.decisionNote,
    adjustsExpenseId: r.adjustsExpenseId,
    markupPct: r.markupPct,
    markupNote: r.markupNote,
    contractorId: r.contractorId,
    contractorInvoiceRef: r.contractorInvoiceRef,
    dueDate: r.dueDate,
    paidAt: r.paidAt,
    paidReference: r.paidReference,
    date: r.date,
    vendor: r.vendor,
    description: r.description,
    amount: r.amount,
    currency: r.currency,
    kind: r.kind,
    category: r.category,
    projectId: r.projectId,
    companyId: r.companyId,
    billable: r.billable,
    invoiceId: r.invoiceId,
    personal: r.personal,
    receiptUrl: r.receiptUrl,
    notes: r.notes,
    source: r.source,
    importId: r.importId,
    account: r.account,
    reference: r.reference,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    project: r.project ? { id: r.project.id, name: r.project.name } : null,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.number } : null,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export type { ParsedRow };
