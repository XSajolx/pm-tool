import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { contacts, deals, proposalRecipients, proposalTemplates, proposalVersions, proposals, type ProposalSection } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { StorageService } from "../files/storage.service.js";
import { DealsService } from "./deals.service.js";
import { NotesService } from "./notes.service.js";
import { renderPdf } from "./pdf.js";

/** Row 56: the fixed skeleton every proposal starts from. */
export const DEFAULT_PROPOSAL_SECTIONS: ProposalSection[] = [
  { key: "scope", title: "Scope of work", body: "What we will deliver, in plain terms.\n\n• \n• \n• " },
  { key: "milestones", title: "Milestones", body: "1. Kickoff & discovery\n2. Design sign-off\n3. Build & QA\n4. Launch" },
  { key: "timeline", title: "Timeline", body: "Estimated duration: X weeks from kickoff. Dates assume feedback within 3 business days at each milestone." },
  { key: "exclusions", title: "Exclusions", body: "Not included in this proposal:\n• Third-party licences and hosting\n• Content and copywriting unless listed above\n• Ongoing maintenance after launch" },
  { key: "assumptions", title: "Assumptions", body: "• The client provides brand assets and access on time.\n• Up to two rounds of revisions per milestone.\n• Work is estimated on the scope above; changes are quoted separately." },
  { key: "terms", title: "Terms", body: "50% on acceptance, 50% on launch. Quote valid for 30 days. Payment due within 14 days of invoice." },
];

export interface ProposalWrite {
  title?: string;
  sections?: ProposalSection[];
  currency?: string;
  total?: number;
  validUntil?: string | null;
  companyId?: string | null;
  contactId?: string | null;
}

export interface TemplateWrite {
  name?: string;
  sections?: ProposalSection[];
  isDefault?: boolean;
}

@Injectable()
export class ProposalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly dealsService: DealsService,
    private readonly notes: NotesService,
  ) {}

  /* ---------------- templates (row 56) ---------------- */

  async templates(orgId: string): Promise<(typeof proposalTemplates.$inferSelect)[]> {
    const rows = await this.db.query.proposalTemplates.findMany({
      where: and(eq(proposalTemplates.organizationId, orgId), isNull(proposalTemplates.archivedAt)),
      orderBy: [desc(proposalTemplates.isDefault), asc(proposalTemplates.name)],
    });
    if (rows.length) return rows;
    await this.db.insert(proposalTemplates).values({ organizationId: orgId, name: "Standard proposal", sections: DEFAULT_PROPOSAL_SECTIONS, isDefault: true });
    return this.templates(orgId);
  }

  async createTemplate(orgId: string, dto: TemplateWrite & { name: string }) {
    if (dto.isDefault) await this.db.update(proposalTemplates).set({ isDefault: false }).where(eq(proposalTemplates.organizationId, orgId));
    const [row] = await this.db
      .insert(proposalTemplates)
      .values({ organizationId: orgId, name: dto.name.trim(), sections: cleanSections(dto.sections ?? DEFAULT_PROPOSAL_SECTIONS), isDefault: Boolean(dto.isDefault) })
      .returning();
    return row!;
  }

  async updateTemplate(orgId: string, id: string, dto: TemplateWrite) {
    const t = await this.db.query.proposalTemplates.findFirst({ where: and(eq(proposalTemplates.id, id), eq(proposalTemplates.organizationId, orgId)) });
    if (!t) throw new NotFoundException("Template not found");
    if (dto.isDefault) await this.db.update(proposalTemplates).set({ isDefault: false }).where(eq(proposalTemplates.organizationId, orgId));
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.sections !== undefined) patch.sections = cleanSections(dto.sections);
    if (dto.isDefault !== undefined) patch.isDefault = dto.isDefault;
    const [row] = await this.db.update(proposalTemplates).set(patch).where(eq(proposalTemplates.id, id)).returning();
    return row!;
  }

  async removeTemplate(orgId: string, id: string) {
    await this.db.update(proposalTemplates).set({ archivedAt: new Date() }).where(and(eq(proposalTemplates.id, id), eq(proposalTemplates.organizationId, orgId)));
    return { id, removed: true };
  }

  /* ---------------- proposals ---------------- */

  async list(orgId: string, opts: { dealId?: string; companyId?: string } = {}) {
    const rows = await this.db.query.proposals.findMany({
      where: and(
        eq(proposals.organizationId, orgId),
        isNull(proposals.archivedAt),
        ...(opts.dealId ? [eq(proposals.dealId, opts.dealId)] : []),
        ...(opts.companyId ? [eq(proposals.companyId, opts.companyId)] : []),
      ),
      with: { deal: { columns: { id: true, title: true } }, company: { columns: { id: true, name: true } }, contact: { columns: { id: true, firstName: true, lastName: true } }, recipients: true },
      orderBy: [desc(proposals.createdAt)],
    });
    return rows.map((p) => ({ ...shapeProposal(p), recipientSummary: summarise(p.recipients) }));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.proposals.findFirst({
      where: and(eq(proposals.id, id), eq(proposals.organizationId, orgId)),
      with: {
        deal: { columns: { id: true, title: true, value: true, currency: true } },
        company: { columns: { id: true, name: true } },
        contact: { columns: { id: true, firstName: true, lastName: true, email: true } },
        createdBy: { columns: { id: true, name: true } },
        versions: { orderBy: [desc(proposalVersions.version)], with: { sentBy: { columns: { id: true, name: true } }, recipients: true } },
      },
    });
    if (!row) throw new NotFoundException("Proposal not found");
    const base = this.storage.publicApiBase();
    const versions = await Promise.all(
      row.versions.map(async (v) => ({
        id: v.id,
        version: v.version,
        title: v.title,
        total: v.total,
        currency: v.currency,
        sentAt: v.sentAt,
        sentBy: v.sentBy ? { id: v.sentBy.id, name: v.sentBy.name } : null,
        pdfUrl: v.pdfKey ? ((await this.storage.signedUrl(v.pdfKey, `${row.number}-v${v.version}.pdf`)) ?? `${base}/api/crm/proposals/${row.id}/versions/${v.version}/pdf`) : null,
        recipients: v.recipients.map((rc) => shapeRecipient(rc, base)),
      })),
    );
    return { ...shapeProposal(row), sections: row.sections, createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null, versions };
  }

  /** Row 56: a new proposal from a template, pre-filled from the deal. */
  async createFromDeal(orgId: string, userId: string, dto: { dealId: string; templateId?: string; title?: string }) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dto.dealId), eq(deals.organizationId, orgId)),
      with: { company: { columns: { name: true } } },
    });
    if (!deal) throw new NotFoundException("Deal not found");
    const all = await this.templates(orgId);
    const template = (dto.templateId ? all.find((t) => t.id === dto.templateId) : undefined) ?? all.find((t) => t.isDefault) ?? all[0]!;
    const number = await this.nextNumber(orgId);
    const [row] = await this.db
      .insert(proposals)
      .values({
        organizationId: orgId,
        number,
        dealId: deal.id,
        companyId: deal.companyId,
        contactId: deal.contactId,
        templateId: template.id,
        title: dto.title?.trim() || `${deal.title}${deal.company ? ` — ${deal.company.name}` : ""}`,
        sections: template.sections,
        currency: deal.currency,
        total: deal.value,
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        createdById: userId,
      })
      .returning();
    await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: deal.id, action: "proposal_created", changes: [{ field: "proposal", from: null, to: number }] });
    await this.dealsService.touch(orgId, deal.id);
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: ProposalWrite) {
    const before = await this.db.query.proposals.findFirst({ where: and(eq(proposals.id, id), eq(proposals.organizationId, orgId)) });
    if (!before) throw new NotFoundException("Proposal not found");
    if (before.status === "accepted") throw new BadRequestException("An accepted proposal can't be edited — create a new one");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title.trim() || before.title;
    if (dto.sections !== undefined) patch.sections = cleanSections(dto.sections);
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.total !== undefined) patch.total = Math.max(0, dto.total);
    if (dto.validUntil !== undefined) patch.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (dto.companyId !== undefined) patch.companyId = dto.companyId;
    if (dto.contactId !== undefined) patch.contactId = dto.contactId;
    await this.db.update(proposals).set(patch).where(eq(proposals.id, id));
    void userId;
    return this.get(orgId, id);
  }

  async archive(orgId: string, id: string) {
    await this.db.update(proposals).set({ archivedAt: new Date() }).where(and(eq(proposals.id, id), eq(proposals.organizationId, orgId)));
    return { id, archived: true };
  }

  /**
   * Rows 57-58: sending freezes a numbered version (with a PDF) and mints one
   * unique link per recipient. Nothing is emailed from here (no mail provider
   * yet) — the links are returned so they can be sent by hand; the log notes
   * who got what.
   */
  async send(orgId: string, userId: string, id: string, recipients: { contactId?: string; name?: string; email?: string }[]) {
    const p = await this.db.query.proposals.findFirst({
      where: and(eq(proposals.id, id), eq(proposals.organizationId, orgId)),
      with: { company: { columns: { name: true } } },
    });
    if (!p) throw new NotFoundException("Proposal not found");
    if (p.status === "accepted") throw new BadRequestException("Already accepted");
    if (!recipients.length) throw new BadRequestException("Pick at least one recipient");

    // Resolve recipients: contacts by id, or ad-hoc name/email.
    const resolved: { contactId: string | null; name: string; email: string | null }[] = [];
    for (const rc of recipients) {
      if (rc.contactId) {
        const c = await this.db.query.contacts.findFirst({ where: and(eq(contacts.id, rc.contactId), eq(contacts.organizationId, orgId)) });
        if (!c) throw new BadRequestException("Unknown contact");
        resolved.push({ contactId: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" "), email: c.email });
      } else if (rc.name?.trim()) {
        resolved.push({ contactId: null, name: rc.name.trim(), email: rc.email?.trim() || null });
      }
    }
    if (!resolved.length) throw new BadRequestException("Pick at least one recipient");

    const version = p.currentVersion + 1;
    const pdf = renderPdf({
      title: p.title,
      subtitle: [p.number, `Version ${version}`, p.company?.name].filter(Boolean).join("  ·  "),
      meta: [
        `Total: ${p.currency} ${p.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        p.validUntil ? `Valid until ${p.validUntil.toISOString().slice(0, 10)}` : "",
        `Prepared ${new Date().toISOString().slice(0, 10)}`,
      ].filter(Boolean),
      sections: p.sections.map((s) => ({ title: s.title, body: s.body })),
      footer: `${p.number} v${version}`,
    });
    const pdfKey = `${orgId}/proposals/${p.id}/${p.number}-v${version}.pdf`;
    await this.storage.put(pdfKey, pdf, "application/pdf");

    const [ver] = await this.db
      .insert(proposalVersions)
      .values({ organizationId: orgId, proposalId: p.id, version, title: p.title, sections: p.sections, currency: p.currency, total: p.total, validUntil: p.validUntil, pdfKey, sentById: userId })
      .returning();
    await this.db.insert(proposalRecipients).values(
      resolved.map((rc) => ({ organizationId: orgId, proposalId: p.id, versionId: ver!.id, contactId: rc.contactId, name: rc.name, email: rc.email, token: randomBytes(24).toString("hex") })),
    );
    await this.db.update(proposals).set({ status: "sent", currentVersion: version, declinedAt: null, updatedAt: new Date() }).where(eq(proposals.id, p.id));

    if (p.dealId) {
      await this.dealsService.touch(orgId, p.dealId);
      await this.notes.create(orgId, userId, "deal", p.dealId, {
        body: `Sent proposal ${p.number} v${version} to ${resolved.map((r) => r.name).join(", ")}`,
        kind: "email",
      });
      await this.activity.record({ orgId, actorId: userId, entityType: "deal", entityId: p.dealId, action: "proposal_sent", changes: [{ field: "version", from: null, to: String(version) }] });
    }
    return this.get(orgId, p.id);
  }

  async versionPdf(orgId: string, id: string, version: number) {
    const v = await this.db.query.proposalVersions.findFirst({ where: and(eq(proposalVersions.proposalId, id), eq(proposalVersions.organizationId, orgId), eq(proposalVersions.version, version)) });
    if (!v?.pdfKey) throw new NotFoundException("No PDF for that version");
    const bytes = await this.storage.readLocal(v.pdfKey);
    if (!bytes) throw new NotFoundException("PDF bytes are not on this server");
    return { bytes, filename: `proposal-v${version}.pdf` };
  }

  /* ---------------- public (client-facing) ---------------- */

  private async recipientByToken(token: string) {
    const rc = await this.db.query.proposalRecipients.findFirst({
      where: eq(proposalRecipients.token, token),
      with: {
        version: true,
        proposal: { with: { company: { columns: { id: true, name: true } }, createdBy: { columns: { id: true, name: true } }, deal: { columns: { ownerId: true, title: true } } } },
      },
    });
    if (!rc) throw new NotFoundException("This link is not valid");
    return rc;
  }

  /** Row 58: opening the link counts as a view (first view is announced to the owner). */
  async view(token: string) {
    const rc = await this.recipientByToken(token);
    const now = new Date();
    const first = !rc.viewedAt;
    await this.db
      .update(proposalRecipients)
      .set({ viewedAt: rc.viewedAt ?? now, lastViewedAt: now, viewCount: rc.viewCount + 1 })
      .where(eq(proposalRecipients.id, rc.id));
    if (rc.proposal.status === "sent") await this.db.update(proposals).set({ status: "viewed", updatedAt: now }).where(eq(proposals.id, rc.proposalId));
    if (first) await this.notifyOwner(rc, "proposal_viewed", `${rc.name} viewed proposal ${rc.proposal.number} v${rc.version.version}`, rc.proposal.title);
    const latest = rc.version.version === rc.proposal.currentVersion;
    return {
      token,
      recipient: { name: rc.name, acceptedAt: rc.acceptedAt, declinedAt: rc.declinedAt, signerName: rc.signerName, signerTitle: rc.signerTitle },
      proposal: {
        number: rc.proposal.number,
        title: rc.version.title,
        version: rc.version.version,
        latest,
        status: rc.proposal.status,
        company: rc.proposal.company?.name ?? null,
        from: rc.proposal.createdBy?.name ?? null,
        currency: rc.version.currency,
        total: rc.version.total,
        validUntil: rc.version.validUntil,
        expired: Boolean(rc.version.validUntil && rc.version.validUntil < now && !rc.acceptedAt),
        sentAt: rc.version.sentAt,
        sections: rc.version.sections,
        pdfUrl: rc.version.pdfKey ? ((await this.storage.signedUrl(rc.version.pdfKey, `${rc.proposal.number}-v${rc.version.version}.pdf`)) ?? `${this.storage.publicApiBase()}/api/public/proposals/${token}/pdf`) : null,
      },
    };
  }

  async publicPdf(token: string) {
    const rc = await this.recipientByToken(token);
    if (!rc.version.pdfKey) throw new NotFoundException("No PDF");
    const bytes = await this.storage.readLocal(rc.version.pdfKey);
    if (!bytes) throw new NotFoundException("PDF bytes are not on this server");
    return { bytes, filename: `${rc.proposal.number}-v${rc.version.version}.pdf` };
  }

  /** Row 59: typed signature. Marks the recipient, the proposal and the deal (→ won). */
  async accept(token: string, input: { signerName: string; signerTitle?: string; agreed: boolean }, meta: { ip?: string; userAgent?: string }) {
    const rc = await this.recipientByToken(token);
    if (rc.acceptedAt) return this.view(token);
    if (!input.agreed) throw new BadRequestException("Please confirm you agree to the terms");
    const signerName = (input.signerName ?? "").trim();
    if (signerName.length < 2) throw new BadRequestException("Type your full name to sign");
    if (rc.version.version !== rc.proposal.currentVersion) throw new BadRequestException("A newer version of this proposal has been sent — please use the latest link");
    if (rc.version.validUntil && rc.version.validUntil < new Date()) throw new BadRequestException("This proposal has expired — ask for a refreshed version");
    const now = new Date();
    await this.db
      .update(proposalRecipients)
      .set({ acceptedAt: now, declinedAt: null, declineReason: null, signerName, signerTitle: input.signerTitle?.trim() || null, signatureIp: meta.ip ?? null, signatureUserAgent: meta.userAgent?.slice(0, 500) ?? null })
      .where(eq(proposalRecipients.id, rc.id));
    await this.db.update(proposals).set({ status: "accepted", acceptedAt: now, declinedAt: null, updatedAt: now }).where(eq(proposals.id, rc.proposalId));
    if (rc.proposal.dealId) {
      const won = (await this.dealsService.stages(rc.proposal.organizationId)).find((s) => s.kind === "won");
      const actor = rc.proposal.createdById ?? rc.proposal.deal?.ownerId ?? null;
      if (won && actor) {
        try {
          await this.dealsService.update(rc.proposal.organizationId, actor, rc.proposal.dealId, { stageId: won.id });
        } catch {
          /* the deal may be gone; the signature still stands */
        }
        await this.notes.create(rc.proposal.organizationId, actor, "deal", rc.proposal.dealId, { body: `${signerName} signed proposal ${rc.proposal.number} v${rc.version.version}`, kind: "note" });
      }
    }
    await this.notifyOwner(rc, "proposal_accepted", `${signerName} accepted proposal ${rc.proposal.number} v${rc.version.version} 🎉`, rc.proposal.title);
    return this.view(token);
  }

  async decline(token: string, reason?: string) {
    const rc = await this.recipientByToken(token);
    if (rc.acceptedAt) throw new BadRequestException("Already accepted");
    const now = new Date();
    await this.db.update(proposalRecipients).set({ declinedAt: now, declineReason: reason?.trim() || null }).where(eq(proposalRecipients.id, rc.id));
    if (rc.proposal.status !== "accepted") await this.db.update(proposals).set({ status: "declined", declinedAt: now, updatedAt: now }).where(eq(proposals.id, rc.proposalId));
    await this.notifyOwner(rc, "proposal_declined", `${rc.name} declined proposal ${rc.proposal.number} v${rc.version.version}`, reason?.trim() || rc.proposal.title);
    return this.view(token);
  }

  private async notifyOwner(rc: Awaited<ReturnType<ProposalsService["recipientByToken"]>>, verb: string, title: string, body: string) {
    const receivers = new Set<string>();
    if (rc.proposal.createdById) receivers.add(rc.proposal.createdById);
    if (rc.proposal.deal?.ownerId) receivers.add(rc.proposal.deal.ownerId);
    for (const receiverId of receivers) {
      await this.notifications.notifyDirect({
        orgId: rc.proposal.organizationId,
        receiverId,
        entityType: "proposal",
        entityId: rc.proposalId,
        verb,
        title,
        body,
        data: { proposalId: rc.proposalId, dealId: rc.proposal.dealId },
      });
    }
  }

  private async nextNumber(orgId: string) {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(proposals).where(eq(proposals.organizationId, orgId));
    return `PRO-${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
  }
}

function cleanSections(sections: ProposalSection[]): ProposalSection[] {
  return sections
    .filter((s) => s && typeof s.title === "string")
    .map((s, i) => ({ key: (s.key || `s${i + 1}`).toString().slice(0, 40), title: s.title.trim().slice(0, 120) || `Section ${i + 1}`, body: (s.body ?? "").toString().slice(0, 20_000) }))
    .slice(0, 30);
}

function summarise(rs: (typeof proposalRecipients.$inferSelect)[]) {
  return { sent: rs.length, viewed: rs.filter((r) => r.viewedAt).length, accepted: rs.filter((r) => r.acceptedAt).length, declined: rs.filter((r) => r.declinedAt).length };
}

function shapeRecipient(rc: typeof proposalRecipients.$inferSelect, _base: string) {
  return {
    id: rc.id,
    contactId: rc.contactId,
    name: rc.name,
    email: rc.email,
    token: rc.token,
    sentAt: rc.sentAt,
    viewedAt: rc.viewedAt,
    lastViewedAt: rc.lastViewedAt,
    viewCount: rc.viewCount,
    acceptedAt: rc.acceptedAt,
    declinedAt: rc.declinedAt,
    declineReason: rc.declineReason,
    signerName: rc.signerName,
    signerTitle: rc.signerTitle,
  };
}

function shapeProposal(p: typeof proposals.$inferSelect & {
  deal?: { id: string; title: string } | null;
  company?: { id: string; name: string } | null;
  contact?: { id: string; firstName: string; lastName: string | null; email?: string | null } | null;
}) {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    status: p.status,
    currency: p.currency,
    total: p.total,
    validUntil: p.validUntil,
    currentVersion: p.currentVersion,
    acceptedAt: p.acceptedAt,
    declinedAt: p.declinedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    dealId: p.dealId,
    companyId: p.companyId,
    contactId: p.contactId,
    templateId: p.templateId,
    deal: p.deal ? { id: p.deal.id, title: p.deal.title } : null,
    company: p.company ? { id: p.company.id, name: p.company.name } : null,
    contact: p.contact ? { id: p.contact.id, name: [p.contact.firstName, p.contact.lastName].filter(Boolean).join(" "), email: p.contact.email ?? null } : null,
  };
}
