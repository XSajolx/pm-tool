import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { docTemplates, documents } from "../../db/schema.js";
import { textOf, type PmNode } from "./doc-content.js";

export interface DocTemplateWrite {
  title?: string;
  icon?: string | null;
  content?: Record<string, unknown> | null;
  body?: string;
  inKit?: boolean;
}

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const h = (text: string, level = 2) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const li = (text: string) => ({ type: "listItem", content: [p(text)] });
const ul = (...items: string[]) => ({ type: "bulletList", content: items.map(li) });
const task = (text: string) => ({ type: "taskItem", attrs: { checked: false }, content: [p(text)] });
const tasks = (...items: string[]) => ({ type: "taskList", content: items.map(task) });

/** The kit a fresh org starts with; editable in Settings. */
export const DEFAULT_KIT: { title: string; icon: string; content: Record<string, unknown> }[] = [
  { title: "Project brief", icon: "🎯", content: { type: "doc", content: [h("Goal"), p("What the client wants to achieve, in one paragraph."), h("Audience"), p(""), h("Scope"), ul("In scope: ", "Out of scope: "), h("Success looks like"), ul("Metric 1", "Metric 2"), h("Constraints"), ul("Budget", "Timeline", "Brand / tech")] } },
  { title: "Kickoff notes", icon: "🚀", content: { type: "doc", content: [h("Attendees"), p(""), h("Decisions"), ul(""), h("Open questions"), ul(""), h("Next steps"), tasks("Send recap to client", "Book weekly check-in")] } },
  { title: "Statement of work", icon: "📝", content: { type: "doc", content: [h("Deliverables"), ul("Deliverable 1", "Deliverable 2"), h("Timeline"), p(""), h("Assumptions"), ul(""), h("Exclusions"), ul(""), h("Change requests"), p("Changes to scope are estimated and approved in writing before work starts.")] } },
  { title: "QA checklist", icon: "🧪", content: { type: "doc", content: [h("Before handover"), tasks("Cross-browser check (Chrome, Safari, Firefox, Edge)", "Mobile layouts at 360 / 768 / 1024", "Forms submit and validate", "404 / error pages", "Performance: LCP under 2.5s on key pages", "Accessibility: headings, alt text, contrast", "Analytics + tracking verified", "Client sign-off recorded")] } },
];

/** Row 68 */
@Injectable()
export class DocTemplatesService {
  private readonly logger = new Logger(DocTemplatesService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async list(orgId: string): Promise<(typeof docTemplates.$inferSelect)[]> {
    const rows = await this.db.query.docTemplates.findMany({
      where: and(eq(docTemplates.organizationId, orgId), isNull(docTemplates.archivedAt)),
      orderBy: [asc(docTemplates.position), asc(docTemplates.createdAt)],
    });
    if (rows.length) return rows;
    await this.db.insert(docTemplates).values(DEFAULT_KIT.map((t, i) => ({ organizationId: orgId, title: t.title, icon: t.icon, content: t.content, body: textOf(t.content as PmNode), position: i + 1, inKit: true })));
    return this.list(orgId);
  }

  async create(orgId: string, dto: DocTemplateWrite & { title: string }) {
    const all = await this.list(orgId);
    const content = dto.content ?? { type: "doc", content: [{ type: "paragraph" }] };
    const [row] = await this.db
      .insert(docTemplates)
      .values({ organizationId: orgId, title: dto.title.trim(), icon: dto.icon ?? "📄", content, body: dto.body ?? textOf(content as PmNode), position: (all.at(-1)?.position ?? 0) + 1, inKit: dto.inKit ?? true })
      .returning();
    return row!;
  }

  async update(orgId: string, id: string, dto: DocTemplateWrite) {
    const t = await this.db.query.docTemplates.findFirst({ where: and(eq(docTemplates.id, id), eq(docTemplates.organizationId, orgId)) });
    if (!t) throw new NotFoundException("Template not found");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title.trim() || t.title;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.inKit !== undefined) patch.inKit = dto.inKit;
    if (dto.content !== undefined) {
      patch.content = dto.content;
      patch.body = dto.body ?? (dto.content ? textOf(dto.content as PmNode) : "");
    }
    const [row] = await this.db.update(docTemplates).set(patch).where(eq(docTemplates.id, id)).returning();
    return row!;
  }

  async reorder(orgId: string, ids: string[]) {
    const all = await this.list(orgId);
    const known = new Set(all.map((t) => t.id));
    const ordered = ids.filter((id) => known.has(id));
    for (const t of all) if (!ordered.includes(t.id)) ordered.push(t.id);
    for (let i = 0; i < ordered.length; i++) await this.db.update(docTemplates).set({ position: i + 1 }).where(eq(docTemplates.id, ordered[i]!));
    return this.list(orgId);
  }

  async remove(orgId: string, id: string) {
    await this.db.update(docTemplates).set({ archivedAt: new Date() }).where(and(eq(docTemplates.id, id), eq(docTemplates.organizationId, orgId)));
    return { id, removed: true };
  }

  /**
   * Create the kit's docs under a project — on project creation and on demand.
   * Titles already present under the project are skipped, so it's safe to re-run.
   * Quiet: no chat "shared a doc" lines for scaffolding.
   */
  async applyKit(orgId: string, userId: string, projectId: string, opts: { onlyInKit?: boolean; templateIds?: string[] } = {}) {
    try {
      const all = await this.list(orgId);
      const chosen = all.filter((t) => (opts.templateIds ? opts.templateIds.includes(t.id) : opts.onlyInKit === false || t.inKit));
      if (!chosen.length) return [];
      const existing = await this.db.query.documents.findMany({ where: and(eq(documents.projectId, projectId), eq(documents.organizationId, orgId), isNull(documents.archivedAt)), columns: { title: true } });
      const have = new Set(existing.map((d) => d.title.toLowerCase()));
      const created: string[] = [];
      for (const t of chosen) {
        if (have.has(t.title.toLowerCase())) continue;
        const [row] = await this.db
          .insert(documents)
          .values({ organizationId: orgId, projectId, title: t.title, icon: t.icon, content: t.content, body: t.body, settings: {}, createdById: userId, updatedById: userId })
          .returning({ id: documents.id });
        created.push(row!.id);
      }
      return created;
    } catch (err) {
      this.logger.warn(`starter kit not applied: ${(err as Error).message}`);
      return [];
    }
  }
}
