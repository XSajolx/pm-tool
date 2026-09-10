import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { companies, contacts } from "../../db/schema.js";
import { ActivityService } from "../activity/activity.service.js";

export interface ContactDto {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  companyId?: string | null;
  isPrimary?: boolean;
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
  ) {}

  async list(orgId: string, opts: { companyId?: string; q?: string } = {}) {
    const rows = await this.db.query.contacts.findMany({
      where: and(
        eq(contacts.organizationId, orgId),
        isNull(contacts.archivedAt),
        ...(opts.companyId ? [eq(contacts.companyId, opts.companyId)] : []),
        ...(opts.q
          ? [
              or(
                ilike(contacts.firstName, `%${opts.q}%`),
                ilike(contacts.lastName, `%${opts.q}%`),
                ilike(contacts.email, `%${opts.q}%`),
              ),
            ]
          : []),
      ),
      with: { company: true },
      orderBy: [asc(contacts.firstName), asc(contacts.lastName)],
    });
    return rows.map(shape);
  }

  async get(orgId: string, id: string) {
    const row = await this.db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.organizationId, orgId)),
      with: { company: true },
    });
    if (!row) throw new NotFoundException("Contact not found");
    return shape(row);
  }

  async create(orgId: string, userId: string, dto: ContactDto) {
    await this.assertCompany(orgId, dto.companyId);
    const [row] = await this.db
      .insert(contacts)
      .values({ organizationId: orgId, createdById: userId, ...dto })
      .returning();
    if (dto.isPrimary && dto.companyId) await this.demoteOthers(dto.companyId, row!.id);
    await this.activity.record({ orgId, actorId: userId, entityType: "contact", entityId: row!.id, action: "created" });
    return this.get(orgId, row!.id);
  }

  async update(orgId: string, userId: string, id: string, dto: Partial<ContactDto>) {
    const before = await this.get(orgId, id);
    await this.assertCompany(orgId, dto.companyId);
    await this.db
      .update(contacts)
      .set({ ...dto, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)));
    const companyId = dto.companyId === undefined ? before.company?.id : dto.companyId;
    if (dto.isPrimary && companyId) await this.demoteOthers(companyId, id);

    const changes = this.activity.diff(
      before as unknown as Record<string, unknown>,
      dto as Record<string, unknown>,
      ["firstName", "lastName", "email", "phone", "title", "companyId"],
    );
    if (changes.length) {
      await this.activity.record({ orgId, actorId: userId, entityType: "contact", entityId: id, action: "updated", changes });
    }
    return this.get(orgId, id);
  }

  async archive(orgId: string, userId: string, id: string) {
    await this.get(orgId, id);
    await this.db
      .update(contacts)
      .set({ archivedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)));
    await this.activity.record({ orgId, actorId: userId, entityType: "contact", entityId: id, action: "archived" });
    return { id, archived: true };
  }

  /** A company has at most one primary contact. */
  private async demoteOthers(companyId: string, keepId: string) {
    await this.db
      .update(contacts)
      .set({ isPrimary: false })
      .where(and(eq(contacts.companyId, companyId), eq(contacts.isPrimary, true)))
      .then(async () => {
        await this.db.update(contacts).set({ isPrimary: true }).where(eq(contacts.id, keepId));
      });
  }

  private async assertCompany(orgId: string, companyId?: string | null) {
    if (!companyId) return;
    const c = await this.db.query.companies.findFirst({
      where: and(eq(companies.id, companyId), eq(companies.organizationId, orgId)),
    });
    if (!c) throw new BadRequestException("Company not found in this organization");
  }
}

function shape(r: typeof contacts.$inferSelect & { company: typeof companies.$inferSelect | null }) {
  return {
    ...r,
    fullName: [r.firstName, r.lastName].filter(Boolean).join(" "),
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
  };
}
