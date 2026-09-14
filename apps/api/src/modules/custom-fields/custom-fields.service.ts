import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { customFieldDefs, customFieldValues, users } from "../../db/schema.js";

export type FieldEntity = "task" | "project" | "contact";
export type FieldType = "text" | "number" | "date" | "select" | "checkbox" | "url" | "user";
export const FIELD_ENTITIES: FieldEntity[] = ["task", "project", "contact"];
export const FIELD_TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox", "url", "user"];

/**
 * Row 114: admin-defined fields on tasks, projects and contacts. Values are
 * validated against the field's type so a "number" never holds prose.
 */
@Injectable()
export class CustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async listDefs(orgId: string, entityType?: FieldEntity) {
    return this.db.query.customFieldDefs.findMany({
      where: and(eq(customFieldDefs.organizationId, orgId), isNull(customFieldDefs.archivedAt), ...(entityType ? [eq(customFieldDefs.entityType, entityType)] : [])),
      orderBy: [asc(customFieldDefs.entityType), asc(customFieldDefs.position), asc(customFieldDefs.createdAt)],
    });
  }

  async createDef(orgId: string, dto: { entityType: FieldEntity; name: string; type: FieldType; options?: string[]; required?: boolean }) {
    if (dto.type === "select" && !(dto.options?.length)) throw new BadRequestException("A dropdown needs at least one option");
    const [agg] = await this.db
      .select({ max: sql<number>`coalesce(max(${customFieldDefs.position}), 0)` })
      .from(customFieldDefs)
      .where(and(eq(customFieldDefs.organizationId, orgId), eq(customFieldDefs.entityType, dto.entityType)));
    const [row] = await this.db
      .insert(customFieldDefs)
      .values({ organizationId: orgId, entityType: dto.entityType, name: dto.name.trim(), type: dto.type, options: dto.type === "select" ? dto.options!.map((o) => o.trim()).filter(Boolean) : null, required: dto.required ?? false, position: Number(agg?.max ?? 0) + 1 })
      .returning();
    return row!;
  }

  async updateDef(orgId: string, id: string, dto: { name?: string; options?: string[]; required?: boolean; position?: number }) {
    const def = await this.db.query.customFieldDefs.findFirst({ where: and(eq(customFieldDefs.id, id), eq(customFieldDefs.organizationId, orgId)) });
    if (!def) throw new NotFoundException("Field not found");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.options !== undefined) {
      if (def.type !== "select") throw new BadRequestException("Only dropdowns have options");
      const opts = dto.options.map((o) => o.trim()).filter(Boolean);
      if (!opts.length) throw new BadRequestException("A dropdown needs at least one option");
      patch.options = opts;
    }
    if (dto.required !== undefined) patch.required = dto.required;
    if (dto.position !== undefined) patch.position = dto.position;
    const [row] = await this.db.update(customFieldDefs).set(patch).where(eq(customFieldDefs.id, id)).returning();
    return row!;
  }

  async reorder(orgId: string, entityType: FieldEntity, ids: string[]) {
    await Promise.all(ids.map((id, i) => this.db.update(customFieldDefs).set({ position: i + 1 }).where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.organizationId, orgId), eq(customFieldDefs.entityType, entityType)))));
    return this.listDefs(orgId, entityType);
  }

  /** Archive: the definition and its values stay in the database, but the field disappears from every form. */
  async archiveDef(orgId: string, id: string) {
    const rows = await this.db.update(customFieldDefs).set({ archivedAt: new Date() }).where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.organizationId, orgId))).returning({ id: customFieldDefs.id });
    if (!rows.length) throw new NotFoundException("Field not found");
    return { id };
  }

  /** Definitions + this record's values, ready for a form. */
  async valuesFor(orgId: string, entityType: FieldEntity, entityId: string) {
    const defs = await this.listDefs(orgId, entityType);
    if (!defs.length) return { fields: [], users: {} };
    const rows = await this.db.query.customFieldValues.findMany({ where: and(eq(customFieldValues.entityId, entityId), inArray(customFieldValues.fieldId, defs.map((d) => d.id))) });
    const byField = new Map(rows.map((v) => [v.fieldId, v.value]));
    const userIds = defs.filter((d) => d.type === "user").map((d) => byField.get(d.id)).filter((v): v is string => typeof v === "string");
    const people = userIds.length ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
    return {
      fields: defs.map((d) => ({ id: d.id, name: d.name, type: d.type as FieldType, options: d.options ?? null, required: d.required, value: byField.get(d.id) ?? null })),
      users: Object.fromEntries(people.map((u) => [u.id, u.name])),
    };
  }

  /** Upsert a batch of values `{ [fieldId]: value }`; null clears. */
  async setValues(orgId: string, userId: string, entityType: FieldEntity, entityId: string, values: Record<string, unknown>) {
    const defs = await this.listDefs(orgId, entityType);
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const [fieldId, raw] of Object.entries(values)) {
      const def = byId.get(fieldId);
      if (!def) throw new BadRequestException("Unknown field");
      const value = normalise(def.type as FieldType, def.options ?? [], raw);
      if (value === null) {
        await this.db.delete(customFieldValues).where(and(eq(customFieldValues.fieldId, fieldId), eq(customFieldValues.entityId, entityId)));
      } else {
        await this.db
          .insert(customFieldValues)
          .values({ organizationId: orgId, fieldId, entityId, value, updatedById: userId })
          .onConflictDoUpdate({ target: [customFieldValues.fieldId, customFieldValues.entityId], set: { value, updatedById: userId, updatedAt: new Date() } });
      }
    }
    return this.valuesFor(orgId, entityType, entityId);
  }
}

/** Coerce + validate one value for its field type; null means "clear". */
function normalise(type: FieldType, options: string[], raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (type) {
    case "text":
      return String(raw).slice(0, 4000);
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n)) throw new BadRequestException("Not a number");
      return n;
    }
    case "date": {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new BadRequestException("Not a date");
      return d.toISOString().slice(0, 10);
    }
    case "select": {
      const v = String(raw);
      if (!options.includes(v)) throw new BadRequestException(`"${v}" isn't one of the options`);
      return v;
    }
    case "checkbox":
      return raw === true || raw === "true" || raw === 1 ? true : false;
    case "url": {
      const v = String(raw).trim();
      if (!/^https?:\/\//i.test(v)) throw new BadRequestException("URL must start with http:// or https://");
      return v.slice(0, 2000);
    }
    case "user": {
      const v = String(raw);
      if (!/^[0-9a-f-]{36}$/i.test(v)) throw new BadRequestException("Pick a person");
      return v;
    }
  }
}
