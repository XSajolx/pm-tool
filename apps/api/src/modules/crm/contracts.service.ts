import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import {
  companies,
  contacts,
  contractEvents,
  contractSigners,
  contractTemplates,
  contracts,
  deals,
  organizations,
  projects,
  users,
  type ContractFields,
  type ProposalSection,
} from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { StorageService } from "../files/storage.service.js";
import { DealsService } from "./deals.service.js";
import { NotesService } from "./notes.service.js";
import { renderPdf } from "./pdf.js";

export type ContractKind = "service_agreement" | "nda" | "retainer" | "contractor" | "custom";
export type ContractStatus = "draft" | "sent" | "viewed" | "signed" | "declined" | "expired";
export type SignatureType = "typed" | "drawn";

export interface SignerWrite {
  id?: string;
  contactId?: string | null;
  name?: string;
  email?: string | null;
}

export interface ContractWrite {
  title?: string;
  kind?: ContractKind;
  sections?: ProposalSection[];
  fields?: ContractFields;
  validUntil?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  projectId?: string | null;
  requireCountersign?: boolean;
  /** Client-side signers; replaces the list (draft only). */
  signers?: SignerWrite[];
}

export interface CreateContractDto extends ContractWrite {
  templateId?: string | null;
}

export interface TemplateWrite {
  name?: string;
  kind?: ContractKind;
  description?: string | null;
  sections?: ProposalSection[];
  isDefault?: boolean;
}

export interface SignInput {
  signatureType: SignatureType;
  name: string;
  title?: string;
  image?: string | null;
  agreed: boolean;
}

export const KIND_LABEL: Record<ContractKind, string> = {
  service_agreement: "Service agreement",
  nda: "Non-disclosure agreement",
  retainer: "Retainer agreement",
  contractor: "Independent contractor agreement",
  custom: "Custom",
};

/** Placeholders the editor advertises; anything else is left as written. */
export const PLACEHOLDERS = [
  ["{{client}}", "Client company name"],
  ["{{client_address}}", "Client address"],
  ["{{contact}}", "Client signer / contact name"],
  ["{{contact_email}}", "Contact email"],
  ["{{our_company}}", "Our company name"],
  ["{{project}}", "Project name"],
  ["{{fee}}", "Fee with currency"],
  ["{{currency}}", "Currency code"],
  ["{{start_date}}", "Start date"],
  ["{{end_date}}", "End date"],
  ["{{date}}", "Date the contract is sent"],
  ["{{number}}", "Contract number"],
  ["{{title}}", "Contract title"],
] as const;

const S = (key: string, title: string, body: string): ProposalSection => ({ key, title, body });

/** Row 159 seed: one starter per service type. Plain-language, placeholder-driven; edit freely in Settings. */
export const DEFAULT_TEMPLATES: { name: string; kind: ContractKind; description: string; sections: ProposalSection[] }[] = [
  {
    name: "Service agreement",
    kind: "service_agreement",
    description: "Project work for a client: scope, fee, timeline, IP, termination.",
    sections: [
      S("parties", "Parties", "This Service Agreement (the \"Agreement\") is made on {{date}} between {{our_company}} (\"Provider\") and {{client}} (\"Client\"), represented by {{contact}}."),
      S("services", "Services", "Provider will deliver the services described in the proposal for {{project}} (the \"Services\"). Changes to scope are agreed in writing and may affect the fee and timeline."),
      S("fee", "Fees & payment", "Client will pay {{fee}} for the Services. Invoices are due within 14 days of issue. Late payments accrue interest at 1.5% per month. Work may pause while an invoice is more than 14 days overdue."),
      S("term", "Term", "The Services start on {{start_date}} and are expected to complete by {{end_date}}, subject to timely feedback and materials from Client."),
      S("ip", "Intellectual property", "On payment in full, Client owns the deliverables created specifically for Client. Provider keeps ownership of its pre-existing tools, templates and know-how and grants Client a licence to use them within the deliverables."),
      S("confidentiality", "Confidentiality", "Each party keeps the other's non-public information confidential and uses it only for this Agreement, for two years after the Agreement ends."),
      S("termination", "Termination", "Either party may end this Agreement with 14 days' written notice. Client pays for work completed and non-cancellable costs up to the end date."),
      S("liability", "Liability", "Provider's total liability under this Agreement is limited to the fees paid in the preceding three months. Neither party is liable for indirect or consequential loss."),
      S("general", "General", "This Agreement is the whole agreement between the parties and is governed by the laws of the Provider's place of business. It may be signed electronically, and electronic signatures are binding."),
    ],
  },
  {
    name: "Mutual NDA",
    kind: "nda",
    description: "Two-way confidentiality before sharing details.",
    sections: [
      S("parties", "Parties", "This Mutual Non-Disclosure Agreement is made on {{date}} between {{our_company}} and {{client}}, represented by {{contact}}."),
      S("purpose", "Purpose", "The parties wish to exchange confidential information to evaluate and carry out a possible business relationship regarding {{project}} (the \"Purpose\")."),
      S("definition", "Confidential information", "Confidential Information means any non-public business, technical, financial or client information disclosed by either party, in any form, that is marked or would reasonably be understood to be confidential."),
      S("obligations", "Obligations", "Each party will use the other's Confidential Information only for the Purpose, protect it with at least reasonable care, and share it only with staff and advisers who need it and are bound by similar terms."),
      S("exclusions", "Exclusions", "Information is not confidential if it is or becomes public through no fault of the receiving party, was already known to it, is independently developed, or must be disclosed by law (with notice where allowed)."),
      S("term", "Term", "This Agreement runs from {{start_date}} for two years. Confidentiality obligations survive for three years after disclosure."),
      S("general", "General", "No licence or obligation to do business is created. Electronic signatures are binding."),
    ],
  },
  {
    name: "Retainer agreement",
    kind: "retainer",
    description: "Ongoing monthly engagement with a fixed fee and included hours.",
    sections: [
      S("parties", "Parties", "This Retainer Agreement is made on {{date}} between {{our_company}} (\"Provider\") and {{client}} (\"Client\"), represented by {{contact}}."),
      S("services", "Retained services", "Provider reserves capacity each month for {{project}}. Work is prioritised with Client at the start of each month. Unused hours do not roll over unless agreed in writing."),
      S("fee", "Monthly fee", "Client pays {{fee}} per month, invoiced in advance on the 1st and due within 7 days. Work beyond the included hours is billed at Provider's standard rate with prior approval."),
      S("term", "Term & renewal", "The retainer starts on {{start_date}} for an initial term to {{end_date}} and then renews month to month. Either party may end it with 30 days' written notice."),
      S("ip", "Intellectual property", "Deliverables are owned by Client once the month they were produced in has been paid for. Provider keeps its pre-existing tools and know-how."),
      S("general", "General", "Confidentiality, liability and governing-law terms follow Provider's standard Service Agreement. Electronic signatures are binding."),
    ],
  },
  {
    name: "Independent contractor agreement",
    kind: "contractor",
    description: "Hiring a freelancer to work on client projects.",
    sections: [
      S("parties", "Parties", "This Independent Contractor Agreement is made on {{date}} between {{our_company}} (\"Company\") and {{contact}} (\"Contractor\")."),
      S("engagement", "Engagement", "Company engages Contractor to provide the services described in the attached brief for {{project}}. Contractor decides how and when to do the work, subject to agreed deadlines and quality standards."),
      S("fee", "Compensation", "Company pays Contractor {{fee}} as set out in the brief, within 14 days of an approved invoice. Contractor is responsible for their own taxes, insurance and equipment."),
      S("status", "Independent status", "Contractor is not an employee, partner or agent of Company and is free to work for others, provided this does not conflict with the Services or the confidentiality terms below."),
      S("ip", "Work product", "All work product created for Company under this Agreement is owned by Company on payment. Contractor waives moral rights to the extent permitted and will sign anything reasonably needed to confirm this."),
      S("confidentiality", "Confidentiality & clients", "Contractor keeps Company and client information confidential and will not solicit Company's clients for 12 months after the engagement ends."),
      S("term", "Term", "The engagement starts on {{start_date}} and ends on {{end_date}} or when the work is accepted, whichever is later. Either party may end it with 7 days' notice; Company pays for work completed."),
      S("general", "General", "This Agreement is governed by the laws of Company's place of business. Electronic signatures are binding."),
    ],
  },
];

@Injectable()
export class ContractsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly dealsService: DealsService,
    private readonly notes: NotesService,
  ) {}

  /* ---------------- templates (rows 158-159) ---------------- */

  async templates(orgId: string): Promise<(typeof contractTemplates.$inferSelect)[]> {
    const rows = await this.db.query.contractTemplates.findMany({
      where: and(eq(contractTemplates.organizationId, orgId), isNull(contractTemplates.archivedAt)),
      orderBy: [asc(contractTemplates.kind), desc(contractTemplates.isDefault), asc(contractTemplates.name)],
    });
    if (rows.length) return rows;
    await this.db.insert(contractTemplates).values(DEFAULT_TEMPLATES.map((t) => ({ organizationId: orgId, name: t.name, kind: t.kind, description: t.description, sections: t.sections, isDefault: true })));
    return this.templates(orgId);
  }

  async createTemplate(orgId: string, dto: TemplateWrite & { name: string }) {
    const kind = dto.kind ?? "custom";
    if (dto.isDefault) await this.db.update(contractTemplates).set({ isDefault: false }).where(and(eq(contractTemplates.organizationId, orgId), eq(contractTemplates.kind, kind)));
    const [row] = await this.db
      .insert(contractTemplates)
      .values({ organizationId: orgId, name: dto.name.trim(), kind, description: dto.description?.trim() || null, sections: cleanSections(dto.sections ?? []), isDefault: Boolean(dto.isDefault) })
      .returning();
    return row!;
  }

  async updateTemplate(orgId: string, id: string, dto: TemplateWrite) {
    const t = await this.db.query.contractTemplates.findFirst({ where: and(eq(contractTemplates.id, id), eq(contractTemplates.organizationId, orgId)) });
    if (!t) throw new NotFoundException("Template not found");
    const kind = dto.kind ?? t.kind;
    if (dto.isDefault) await this.db.update(contractTemplates).set({ isDefault: false }).where(and(eq(contractTemplates.organizationId, orgId), eq(contractTemplates.kind, kind)));
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim() || t.name;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
    if (dto.sections !== undefined) patch.sections = cleanSections(dto.sections);
    if (dto.isDefault !== undefined) patch.isDefault = dto.isDefault;
    const [row] = await this.db.update(contractTemplates).set(patch).where(eq(contractTemplates.id, id)).returning();
    return row!;
  }

  async removeTemplate(orgId: string, id: string) {
    await this.db.update(contractTemplates).set({ archivedAt: new Date(), isDefault: false }).where(and(eq(contractTemplates.id, id), eq(contractTemplates.organizationId, orgId)));
    return { id, removed: true };
  }

  /* ---------------- contracts ---------------- */

  async list(orgId: string, opts: { companyId?: string; dealId?: string; projectId?: string; status?: string } = {}) {
    const rows = await this.db.query.contracts.findMany({
      where: and(
        eq(contracts.organizationId, orgId),
        isNull(contracts.archivedAt),
        ...(opts.companyId ? [eq(contracts.companyId, opts.companyId)] : []),
        ...(opts.dealId ? [eq(contracts.dealId, opts.dealId)] : []),
        ...(opts.projectId ? [eq(contracts.projectId, opts.projectId)] : []),
        ...(opts.status && opts.status !== "all" ? [eq(contracts.status, opts.status as ContractStatus)] : []),
      ),
      with: {
        company: { columns: { id: true, name: true } },
        contact: { columns: { id: true, firstName: true, lastName: true, email: true } },
        deal: { columns: { id: true, title: true } },
        project: { columns: { id: true, name: true } },
        signers: true,
      },
      orderBy: [desc(contracts.createdAt)],
    });
    return rows.map((r) => ({ ...shapeContract(r), signers: r.signers.sort((a, b) => a.position - b.position).map((s) => shapeSigner(s)) }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.contracts.findFirst({
      where: and(eq(contracts.id, id), eq(contracts.organizationId, orgId)),
      with: {
        company: { columns: { id: true, name: true } },
        contact: { columns: { id: true, firstName: true, lastName: true, email: true } },
        deal: { columns: { id: true, title: true } },
        project: { columns: { id: true, name: true } },
        createdBy: { columns: { id: true, name: true } },
        signers: { orderBy: asc(contractSigners.position) },
        events: { orderBy: asc(contractEvents.createdAt), with: { actor: { columns: { id: true, name: true } }, signer: { columns: { id: true, name: true, role: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Contract not found");
    return {
      ...shapeContract(row),
      sections: row.sections,
      rendered: row.rendered,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      signers: row.signers.map((s) => shapeSigner(s)),
      events: row.events.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, at: e.createdAt, ip: e.ip, actor: e.actor ? { id: e.actor.id, name: e.actor.name } : null, signer: e.signer ? { id: e.signer.id, name: e.signer.name, role: e.signer.role } : null })),
      pdfUrl: row.pdfKey ? await this.storage.signedUrl(row.pdfKey, `${row.number}.pdf`) : null,
      placeholders: PLACEHOLDERS,
    };
  }

  /** New contract from a template, pre-filled from whichever CRM record it hangs off. */
  async create(orgId: string, userId: string, dto: CreateContractDto) {
    await this.assertLinks(orgId, dto);
    const all = await this.templates(orgId);
    const kind = dto.kind ?? "service_agreement";
    const template = (dto.templateId ? all.find((t) => t.id === dto.templateId) : undefined) ?? all.find((t) => t.kind === kind && t.isDefault) ?? all.find((t) => t.kind === kind) ?? all[0]!;

    // Pull client/project context from the deal or project when not given explicitly.
    let companyId = dto.companyId ?? null;
    let contactId = dto.contactId ?? null;
    let projectId = dto.projectId ?? null;
    const fields: ContractFields = { currency: "USD", ...(dto.fields ?? {}) };
    let titleHint = "";
    if (dto.dealId) {
      const deal = await this.db.query.deals.findFirst({ where: and(eq(deals.id, dto.dealId), eq(deals.organizationId, orgId)) });
      if (deal) {
        companyId ??= deal.companyId;
        contactId ??= deal.contactId;
        projectId ??= deal.projectId ?? null;
        fields.fee ??= deal.value;
        fields.currency = dto.fields?.currency ?? deal.currency;
        titleHint = deal.title;
      }
    }
    if (projectId) {
      const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)) });
      if (project) {
        companyId ??= project.companyId ?? null;
        fields.fee ??= project.budgetAmount ?? null;
        fields.startDate ??= project.startDate ? project.startDate.toISOString().slice(0, 10) : null;
        fields.endDate ??= project.endDate ? project.endDate.toISOString().slice(0, 10) : null;
        titleHint ||= project.name;
      }
    }
    let companyName = "";
    if (companyId) {
      const c = await this.db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { name: true } });
      companyName = c?.name ?? "";
      if (!contactId) {
        const primary = await this.db.query.contacts.findFirst({ where: and(eq(contacts.companyId, companyId), eq(contacts.organizationId, orgId)), orderBy: [desc(contacts.isPrimary)] });
        contactId = primary?.id ?? null;
      }
    }
    const title = (dto.title?.trim() || `${template.kind === "custom" ? template.name : KIND_LABEL[template.kind]}${companyName ? ` — ${companyName}` : titleHint ? ` — ${titleHint}` : ""}`).slice(0, 255);

    for (let attempt = 0; attempt < 3; attempt++) {
      const number = await this.nextNumber(orgId);
      try {
        const id = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(contracts)
            .values({
              organizationId: orgId,
              createdById: userId,
              number,
              title,
              kind: template.kind,
              templateId: template.id,
              companyId,
              contactId,
              dealId: dto.dealId ?? null,
              projectId,
              sections: template.sections,
              fields,
              validUntil: dto.validUntil ? new Date(dto.validUntil) : new Date(Date.now() + 30 * 86_400_000),
              requireCountersign: dto.requireCountersign ?? true,
            })
            .returning();
          const signerRows: (typeof contractSigners.$inferInsert)[] = [];
          const clientSigners = dto.signers?.length ? dto.signers : contactId ? [{ contactId }] : [];
          let pos = 1;
          for (const sg of clientSigners) {
            const resolved = await this.resolveSigner(orgId, sg);
            if (resolved) signerRows.push({ organizationId: orgId, contractId: row!.id, role: "client", position: pos++, ...resolved });
          }
          const me = await tx.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true, email: true } });
          signerRows.push({ organizationId: orgId, contractId: row!.id, role: "company", position: 100, name: me?.name ?? "Authorised signatory", email: me?.email ?? null, userId });
          await tx.insert(contractSigners).values(signerRows);
          await tx.insert(contractEvents).values({ organizationId: orgId, contractId: row!.id, actorUserId: userId, kind: "created", detail: `Created from template "${template.name}"` });
          return row!.id;
        });
        await this.activity.record({ orgId, actorId: userId, entityType: "contract", entityId: id, action: "created", changes: [{ field: "number", from: null, to: number }] });
        if (dto.dealId) await this.dealsService.touch(orgId, dto.dealId);
        return this.get(orgId, id);
      } catch (err) {
        if (!String((err as Error).message).includes("contracts_org_number_uq") || attempt === 2) throw err;
      }
    }
    throw new BadRequestException("Could not allocate a contract number");
  }

  async update(orgId: string, userId: string, id: string, dto: ContractWrite) {
    const before = await this.get(orgId, id);
    if (before.status !== "draft") throw new BadRequestException("Only a draft can be edited — pull it back to draft first (possible while nobody has signed)");
    await this.assertLinks(orgId, dto);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title.trim() || before.title;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.sections !== undefined) patch.sections = cleanSections(dto.sections);
    if (dto.fields !== undefined) patch.fields = { ...before.fields, ...dto.fields, custom: { ...(before.fields.custom ?? {}), ...(dto.fields.custom ?? {}) } };
    if (dto.validUntil !== undefined) patch.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    for (const k of ["companyId", "contactId", "dealId", "projectId"] as const) if (dto[k] !== undefined) patch[k] = dto[k];
    if (dto.requireCountersign !== undefined) patch.requireCountersign = dto.requireCountersign;

    await this.db.transaction(async (tx) => {
      await tx.update(contracts).set(patch).where(eq(contracts.id, id));
      if (dto.signers) {
        await tx.delete(contractSigners).where(and(eq(contractSigners.contractId, id), eq(contractSigners.role, "client")));
        let pos = 1;
        for (const sg of dto.signers) {
          const resolved = await this.resolveSigner(orgId, sg);
          if (resolved) await tx.insert(contractSigners).values({ organizationId: orgId, contractId: id, role: "client", position: pos++, ...resolved });
        }
      }
    });
    void userId;
    return this.get(orgId, id);
  }

  /** Who signs on our side (owner/admin can reassign while draft). */
  async setCompanySigner(orgId: string, userId: string, id: string, targetUserId: string) {
    const c = await this.get(orgId, id);
    if (c.status !== "draft") throw new BadRequestException("Only a draft can change its signatory");
    const u = await this.db.query.users.findFirst({ where: eq(users.id, targetUserId), columns: { id: true, name: true, email: true } });
    if (!u) throw new BadRequestException("Unknown user");
    await this.db.update(contractSigners).set({ userId: u.id, name: u.name, email: u.email }).where(and(eq(contractSigners.contractId, id), eq(contractSigners.role, "company")));
    void userId;
    return this.get(orgId, id);
  }

  /**
   * Sending freezes the text (placeholders resolved) and mints one link per
   * client signer. Nothing is emailed; links are shown to copy by hand.
   */
  async send(orgId: string, userId: string, id: string) {
    const c = await this.get(orgId, id);
    if (c.status !== "draft") throw new BadRequestException("Only a draft can be sent");
    const clientSigners = c.signers.filter((s) => s.role === "client");
    if (!clientSigners.length) throw new BadRequestException("Add at least one client signer");
    if (!c.sections.length) throw new BadRequestException("The contract has no sections");
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true } });
    const company = c.company ? await this.db.query.companies.findFirst({ where: eq(companies.id, c.company.id), columns: { name: true, address: true } }) : null;
    const rendered = renderSections(c.sections, {
      client: company?.name ?? c.company?.name ?? "",
      client_address: company?.address ?? "",
      contact: clientSigners[0]!.name,
      contact_email: clientSigners[0]!.email ?? "",
      our_company: org?.name ?? "",
      project: c.project?.name ?? "",
      fee: c.fields.fee != null ? `${c.fields.currency ?? "USD"} ${Number(c.fields.fee).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "",
      currency: c.fields.currency ?? "USD",
      start_date: c.fields.startDate ?? "",
      end_date: c.fields.endDate ?? "",
      date: new Date().toISOString().slice(0, 10),
      number: c.number,
      title: c.title,
      ...(c.fields.custom ?? {}),
    });
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(contracts).set({ status: "sent", rendered, sentAt: now, declinedAt: null, declineReason: null, updatedAt: now }).where(eq(contracts.id, id));
      for (const s of clientSigners) {
        await tx.update(contractSigners).set({ token: randomBytes(24).toString("hex"), sentAt: now, declinedAt: null, declineReason: null }).where(eq(contractSigners.id, s.id));
      }
      await tx.insert(contractEvents).values({ organizationId: orgId, contractId: id, actorUserId: userId, kind: "sent", detail: `Sent to ${clientSigners.map((s) => s.name).join(", ")}` });
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "contract", entityId: id, action: "sent" });
    if (c.deal) {
      await this.dealsService.touch(orgId, c.deal.id);
      await this.notes.create(orgId, userId, "deal", c.deal.id, { body: `Sent contract ${c.number} (${c.title}) to ${clientSigners.map((s) => s.name).join(", ")}`, kind: "email" });
    }
    return this.get(orgId, id);
  }

  /** Back to draft while nobody has signed: the frozen text is discarded and links stop working. */
  async reopen(orgId: string, userId: string, id: string) {
    const c = await this.get(orgId, id);
    if (c.status === "draft") return c;
    if (c.signers.some((s) => s.signedAt)) throw new BadRequestException("Someone has already signed — create a new contract instead");
    await this.db.transaction(async (tx) => {
      await tx.update(contracts).set({ status: "draft", rendered: null, sentAt: null, viewedAt: null, declinedAt: null, declineReason: null, expiredAt: null, updatedAt: new Date() }).where(eq(contracts.id, id));
      await tx.update(contractSigners).set({ token: null, sentAt: null, viewedAt: null, lastViewedAt: null, viewCount: 0, declinedAt: null, declineReason: null }).where(eq(contractSigners.contractId, id));
      await tx.insert(contractEvents).values({ organizationId: orgId, contractId: id, actorUserId: userId, kind: "reopened", detail: "Pulled back to draft" });
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "contract", entityId: id, action: "reopened" });
    return this.get(orgId, id);
  }

  /** Our side signs in-app. Allowed any time after sending (before or after the client). */
  async countersign(orgId: string, userId: string, id: string, input: SignInput, meta: { ip?: string; userAgent?: string }) {
    const c = await this.get(orgId, id);
    if (!["sent", "viewed", "signed"].includes(c.status)) throw new BadRequestException(`Cannot countersign a ${c.status} contract`);
    const signer = c.signers.find((s) => s.role === "company");
    if (!signer) throw new BadRequestException("No company signer on this contract");
    if (signer.signedAt) throw new BadRequestException("Already countersigned");
    validateSignature(input);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(contractSigners)
        .set({ signedAt: now, userId, signatureType: input.signatureType, signatureName: input.name.trim(), signatureTitle: input.title?.trim() || null, signatureImage: input.signatureType === "drawn" ? input.image : null, signatureIp: meta.ip ?? null, signatureUserAgent: meta.userAgent?.slice(0, 500) ?? null })
        .where(eq(contractSigners.id, signer.id));
      await tx.insert(contractEvents).values({ organizationId: orgId, contractId: id, signerId: signer.id, actorUserId: userId, kind: "countersigned", detail: `${input.name.trim()} signed for the company (${input.signatureType})`, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 500) ?? null });
    });
    await this.activity.record({ orgId, actorId: userId, entityType: "contract", entityId: id, action: "countersigned" });
    await this.checkCompleted(orgId, id, userId);
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db.update(contracts).set({ archivedAt: new Date() }).where(eq(contracts.id, id));
    await this.activity.record({ orgId, actorId: userId, entityType: "contract", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /** "Save as template" from a contract's working copy (row 159). */
  async saveAsTemplate(orgId: string, id: string, dto: { name: string; kind?: ContractKind; isDefault?: boolean }) {
    const c = await this.get(orgId, id);
    return this.createTemplate(orgId, { name: dto.name, kind: dto.kind ?? c.kind, description: `Saved from ${c.number}`, sections: c.sections, isDefault: dto.isDefault });
  }

  /* ---------------- PDF ---------------- */

  async pdf(orgId: string, id: string) {
    const c = await this.get(orgId, id);
    if (c.pdfKey) {
      const stored = await this.storage.readLocal(c.pdfKey);
      if (stored) return { bytes: stored, filename: `${c.number}.pdf` };
    }
    return { bytes: await this.render(orgId, c), filename: `${c.number}.pdf` };
  }

  private async render(orgId: string, c: Awaited<ReturnType<ContractsService["get"]>>) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { name: true, brandFooter: true } });
    const body = c.rendered ?? c.sections;
    const sigLines = c.signers.map((s) => {
      const who = `${s.role === "company" ? org?.name ?? "Provider" : c.company?.name ?? "Client"}: ${s.signatureName ?? s.name}${s.signatureTitle ? `, ${s.signatureTitle}` : ""}`;
      return s.signedAt
        ? `${who}\n   /s/ ${s.signatureName ?? s.name}  —  signed ${s.signedAt.toISOString().replace("T", " ").slice(0, 16)} UTC (${s.signatureType === "drawn" ? "drawn signature on file" : "typed signature"})${s.signatureIp ? `, IP ${s.signatureIp}` : ""}`
        : `${who}\n   ____________________________  (not yet signed)`;
    });
    const audit = c.events.map((e) => `${e.at.toISOString().replace("T", " ").slice(0, 16)} UTC — ${e.kind}${e.detail ? `: ${e.detail}` : ""}${e.ip ? ` (IP ${e.ip})` : ""}`);
    return renderPdf({
      title: c.title,
      subtitle: [c.number, KIND_LABEL[c.kind], c.company?.name].filter(Boolean).join("  ·  "),
      meta: [c.status === "signed" && c.signedAt ? `Executed ${c.signedAt.toISOString().slice(0, 10)}` : `Status: ${c.status}`, c.sentAt ? `Sent ${c.sentAt.toISOString().slice(0, 10)}` : "", c.validUntil ? `Sign by ${c.validUntil.toISOString().slice(0, 10)}` : ""].filter(Boolean),
      sections: [...body.map((s) => ({ title: s.title, body: s.body })), { title: "Signatures", body: sigLines.join("\n\n") }, { title: "Audit trail", body: audit.join("\n") }],
      footer: [org?.brandFooter, c.number].filter(Boolean).join("  ·  "),
    });
  }

  /* ---------------- public (client link) ---------------- */

  private async signerByToken(token: string) {
    if (!token || token.length < 16) throw new NotFoundException("This link is not valid");
    const s = await this.db.query.contractSigners.findFirst({ where: eq(contractSigners.token, token), with: { contract: { columns: { id: true, organizationId: true, status: true, archivedAt: true } } } });
    if (!s || s.contract.archivedAt || s.contract.status === "draft") throw new NotFoundException("This link is not valid");
    return s;
  }

  async view(token: string, meta: { ip?: string; userAgent?: string } = {}) {
    const s = await this.signerByToken(token);
    const orgId = s.contract.organizationId;
    const now = new Date();
    const first = !s.viewedAt;
    await this.db.update(contractSigners).set({ viewedAt: s.viewedAt ?? now, lastViewedAt: now, viewCount: s.viewCount + 1 }).where(eq(contractSigners.id, s.id));
    const c0 = await this.db.query.contracts.findFirst({ where: eq(contracts.id, s.contractId), columns: { status: true, validUntil: true, viewedAt: true, createdById: true, number: true, title: true } });
    if (c0?.status === "sent") await this.db.update(contracts).set({ status: "viewed", viewedAt: now, updatedAt: now }).where(eq(contracts.id, s.contractId));
    if (c0 && ["sent", "viewed"].includes(c0.status) && c0.validUntil && c0.validUntil < now) {
      await this.db.update(contracts).set({ status: "expired", expiredAt: now, updatedAt: now }).where(eq(contracts.id, s.contractId));
      await this.db.insert(contractEvents).values({ organizationId: orgId, contractId: s.contractId, kind: "expired", detail: "Signing deadline passed" });
    }
    if (first) {
      await this.db.insert(contractEvents).values({ organizationId: orgId, contractId: s.contractId, signerId: s.id, kind: "viewed", detail: `${s.name} opened the contract`, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 500) ?? null });
      if (c0?.createdById) await this.notifications.notifyDirect({ orgId, receiverId: c0.createdById, entityType: "contract", entityId: s.contractId, verb: "contract_viewed", title: `${s.name} opened contract ${c0.number}`, body: c0.title, data: { contractId: s.contractId } });
    }
    return this.publicShape(token, s.id);
  }

  private async publicShape(token: string, signerId: string) {
    const s = await this.db.query.contractSigners.findFirst({ where: eq(contractSigners.id, signerId) });
    if (!s) throw new NotFoundException("This link is not valid");
    const c = await this.get(s.organizationId, s.contractId);
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, s.organizationId), columns: { name: true, brandColor: true, brandLogoUrl: true, brandFooter: true } });
    const now = new Date();
    return {
      token,
      signer: { id: s.id, name: s.name, email: s.email, signedAt: s.signedAt, signatureType: s.signatureType, signatureName: s.signatureName, signatureTitle: s.signatureTitle, signatureImage: s.signatureImage, declinedAt: s.declinedAt },
      contract: {
        number: c.number,
        title: c.title,
        kind: c.kind,
        kindLabel: KIND_LABEL[c.kind],
        status: c.status,
        sentAt: c.sentAt,
        signedAt: c.signedAt,
        validUntil: c.validUntil,
        expired: c.status === "expired" || Boolean(c.validUntil && c.validUntil < now && !s.signedAt && c.status !== "signed"),
        company: c.company?.name ?? null,
        sections: c.rendered ?? c.sections,
        parties: c.signers.map((p) => ({ role: p.role, name: p.signatureName ?? p.name, title: p.signatureTitle, signedAt: p.signedAt, signatureType: p.signatureType, signatureImage: p.signatureImage, me: p.id === s.id })),
        pdfUrl: `${this.storage.publicApiBase()}/api/public/contracts/${token}/pdf`,
      },
      from: { name: org?.name ?? "", color: org?.brandColor ?? "#6366f1", logoUrl: org?.brandLogoUrl ?? null, footer: org?.brandFooter ?? null },
    };
  }

  async publicPdf(token: string) {
    const s = await this.signerByToken(token);
    return this.pdf(s.contract.organizationId, s.contractId);
  }

  /** The client signs: typed name or a drawn signature image, plus consent. */
  async sign(token: string, input: SignInput, meta: { ip?: string; userAgent?: string }) {
    const s = await this.signerByToken(token);
    if (s.signedAt) return this.publicShape(token, s.id);
    const orgId = s.contract.organizationId;
    const c = await this.db.query.contracts.findFirst({ where: eq(contracts.id, s.contractId), columns: { status: true, validUntil: true, number: true, title: true, createdById: true, dealId: true } });
    if (!c || !["sent", "viewed", "signed"].includes(c.status)) throw new BadRequestException(c?.status === "expired" ? "This contract has expired — ask for a fresh one" : "This contract can no longer be signed");
    if (c.validUntil && c.validUntil < new Date()) throw new BadRequestException("The signing deadline has passed — ask the sender for a fresh contract");
    validateSignature(input);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(contractSigners)
        .set({ signedAt: now, declinedAt: null, declineReason: null, signatureType: input.signatureType, signatureName: input.name.trim(), signatureTitle: input.title?.trim() || null, signatureImage: input.signatureType === "drawn" ? input.image : null, signatureIp: meta.ip ?? null, signatureUserAgent: meta.userAgent?.slice(0, 500) ?? null })
        .where(eq(contractSigners.id, s.id));
      await tx.insert(contractEvents).values({ organizationId: orgId, contractId: s.contractId, signerId: s.id, kind: "signed", detail: `${input.name.trim()} signed (${input.signatureType})`, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 500) ?? null });
    });
    if (c.createdById) {
      await this.notifications.notifyDirect({ orgId, receiverId: c.createdById, entityType: "contract", entityId: s.contractId, verb: "contract_signed", title: `${input.name.trim()} signed contract ${c.number}`, body: c.title, data: { contractId: s.contractId } });
    }
    if (c.dealId && c.createdById) await this.notes.create(orgId, c.createdById, "deal", c.dealId, { body: `${input.name.trim()} signed contract ${c.number}`, kind: "note" });
    await this.checkCompleted(orgId, s.contractId, c.createdById);
    return this.publicShape(token, s.id);
  }

  async decline(token: string, reason: string | undefined, meta: { ip?: string; userAgent?: string }) {
    const s = await this.signerByToken(token);
    if (s.signedAt) throw new BadRequestException("Already signed");
    const orgId = s.contract.organizationId;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(contractSigners).set({ declinedAt: now, declineReason: reason?.trim() || null }).where(eq(contractSigners.id, s.id));
      await tx.update(contracts).set({ status: "declined", declinedAt: now, declineReason: reason?.trim() || null, updatedAt: now }).where(and(eq(contracts.id, s.contractId), sql`${contracts.status} <> 'signed'`));
      await tx.insert(contractEvents).values({ organizationId: orgId, contractId: s.contractId, signerId: s.id, kind: "declined", detail: `${s.name} declined${reason?.trim() ? `: ${reason.trim()}` : ""}`, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 500) ?? null });
    });
    const c = await this.db.query.contracts.findFirst({ where: eq(contracts.id, s.contractId), columns: { createdById: true, number: true, title: true } });
    if (c?.createdById) await this.notifications.notifyDirect({ orgId, receiverId: c.createdById, entityType: "contract", entityId: s.contractId, verb: "contract_declined", title: `${s.name} declined contract ${c.number}`, body: reason?.trim() || c.title, data: { contractId: s.contractId } });
    return this.publicShape(token, s.id);
  }

  /* ---------------- helpers ---------------- */

  /** Executed when every client signer has signed and (if required) we have countersigned. Stores the PDF. */
  private async checkCompleted(orgId: string, id: string, actorId: string | null) {
    const c = await this.get(orgId, id);
    if (c.status === "signed") return;
    const clients = c.signers.filter((s) => s.role === "client");
    const company = c.signers.find((s) => s.role === "company");
    const done = clients.length > 0 && clients.every((s) => s.signedAt) && (!c.requireCountersign || Boolean(company?.signedAt));
    if (!done) return;
    const now = new Date();
    await this.db.update(contracts).set({ status: "signed", signedAt: now, updatedAt: now }).where(eq(contracts.id, id));
    await this.db.insert(contractEvents).values({ organizationId: orgId, contractId: id, actorUserId: actorId, kind: "completed", detail: "All parties signed — contract executed" });
    const executed = await this.get(orgId, id);
    const bytes = await this.render(orgId, executed);
    const pdfKey = `${orgId}/contracts/${id}/${executed.number}-signed.pdf`;
    try {
      await this.storage.put(pdfKey, bytes, "application/pdf");
      await this.db.update(contracts).set({ pdfKey }).where(eq(contracts.id, id));
    } catch {
      /* the on-demand render still works without a stored copy */
    }
    await this.activity.record({ orgId, actorId, entityType: "contract", entityId: id, action: "signed", changes: [{ field: "status", from: c.status, to: "signed" }] });
    if (c.createdBy) {
      await this.notifications.notifyDirect({ orgId, receiverId: c.createdBy.id, entityType: "contract", entityId: id, verb: "contract_completed", title: `Contract ${c.number} is fully signed 🎉`, body: c.title, data: { contractId: id, dealId: c.deal?.id ?? null } });
    }
  }

  private async resolveSigner(orgId: string, sg: SignerWrite): Promise<{ contactId: string | null; name: string; email: string | null } | null> {
    if (sg.contactId) {
      const c = await this.db.query.contacts.findFirst({ where: and(eq(contacts.id, sg.contactId), eq(contacts.organizationId, orgId)) });
      if (!c) throw new BadRequestException("Unknown contact");
      return { contactId: c.id, name: sg.name?.trim() || [c.firstName, c.lastName].filter(Boolean).join(" "), email: sg.email?.trim() || c.email };
    }
    if (sg.name?.trim()) return { contactId: null, name: sg.name.trim().slice(0, 255), email: sg.email?.trim() || null };
    return null;
  }

  private async nextNumber(orgId: string) {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(eq(contracts.organizationId, orgId));
    return `CON-${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
  }

  private async assertLinks(orgId: string, dto: Partial<ContractWrite>) {
    const checks: [string | null | undefined, () => Promise<unknown>, string][] = [
      [dto.companyId, () => this.db.query.companies.findFirst({ where: and(eq(companies.id, dto.companyId!), eq(companies.organizationId, orgId)) }), "Company"],
      [dto.contactId, () => this.db.query.contacts.findFirst({ where: and(eq(contacts.id, dto.contactId!), eq(contacts.organizationId, orgId)) }), "Contact"],
      [dto.dealId, () => this.db.query.deals.findFirst({ where: and(eq(deals.id, dto.dealId!), eq(deals.organizationId, orgId)) }), "Deal"],
      [dto.projectId, () => this.db.query.projects.findFirst({ where: and(eq(projects.id, dto.projectId!), eq(projects.organizationId, orgId)) }), "Project"],
    ];
    for (const [id, find, label] of checks) if (id && !(await find())) throw new BadRequestException(`${label} not found in this organization`);
  }
}

/** {{key}} → value; unknown keys stay visible so nothing silently disappears. */
export function renderSections(sections: ProposalSection[], ctx: Record<string, string>): ProposalSection[] {
  return sections.map((s) => ({ ...s, title: fill(s.title, ctx), body: fill(s.body, ctx) }));
}

function fill(text: string, ctx: Record<string, string>) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, key: string) => {
    const v = ctx[key];
    return v === undefined ? m : v || "________";
  });
}

function validateSignature(input: SignInput) {
  if (!input.agreed) throw new BadRequestException("Please confirm you agree to the terms");
  if ((input.name ?? "").trim().length < 2) throw new BadRequestException("Type your full name to sign");
  if (input.signatureType === "drawn") {
    if (!input.image || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new BadRequestException("Draw your signature first");
    if (input.image.length > 300_000) throw new BadRequestException("Signature image is too large");
  }
}

function cleanSections(sections: ProposalSection[]): ProposalSection[] {
  return sections
    .filter((s) => s && typeof s.title === "string")
    .map((s, i) => ({ key: (s.key || `s${i + 1}`).toString().slice(0, 40), title: s.title.trim().slice(0, 120) || `Section ${i + 1}`, body: (s.body ?? "").toString().slice(0, 30_000) }))
    .slice(0, 40);
}

function shapeSigner(s: typeof contractSigners.$inferSelect) {
  return {
    id: s.id,
    role: s.role,
    name: s.name,
    email: s.email,
    contactId: s.contactId,
    userId: s.userId,
    token: s.token,
    sentAt: s.sentAt,
    viewedAt: s.viewedAt,
    lastViewedAt: s.lastViewedAt,
    viewCount: s.viewCount,
    signedAt: s.signedAt,
    signatureType: s.signatureType,
    signatureName: s.signatureName,
    signatureTitle: s.signatureTitle,
    signatureImage: s.signatureImage,
    signatureIp: s.signatureIp,
    declinedAt: s.declinedAt,
    declineReason: s.declineReason,
  };
}

function shapeContract(
  r: typeof contracts.$inferSelect & {
    company: { id: string; name: string } | null;
    contact: { id: string; firstName: string; lastName: string | null; email: string | null } | null;
    deal: { id: string; title: string } | null;
    project: { id: string; name: string } | null;
  },
) {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    status: r.status,
    fields: r.fields,
    validUntil: r.validUntil,
    requireCountersign: r.requireCountersign,
    sentAt: r.sentAt,
    viewedAt: r.viewedAt,
    signedAt: r.signedAt,
    declinedAt: r.declinedAt,
    declineReason: r.declineReason,
    expiredAt: r.expiredAt,
    pdfKey: r.pdfKey,
    templateId: r.templateId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    contact: r.contact ? { id: r.contact.id, name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(" "), email: r.contact.email } : null,
    deal: r.deal ? { id: r.deal.id, title: r.deal.title } : null,
    project: r.project ? { id: r.project.id, name: r.project.name } : null,
  };
}
