import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { channelMembers, channels, comments, companies, contacts, lists, messages, projects, statuses, tasks, users } from "../../db/schema.js";
import { ProjectAccessService, type Viewer } from "../access/project-access.service.js";
import { DocumentsService } from "../documents/documents.service.js";
import type { Role } from "../auth/auth.types.js";

/**
 * Row 123: one query across tasks, projects, docs, contacts, companies, chat
 * messages and comments, grouped by type. Respects what the viewer can see
 * (project visibility for tasks/comments, channel membership for chat, doc
 * permissions via DocumentsService). Docs use Postgres full-text search on
 * title + body, ranked, with a plain match as a fallback for short words.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly access: ProjectAccessService,
    private readonly documents: DocumentsService,
  ) {}

  async search(orgId: string, viewer: Viewer & { role: Role }, rawQ: string, perGroup = 8) {
    const q = rawQ.trim();
    if (q.length < 2) return { q, groups: [] };
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const visible = await this.access.visibleProjectIds(orgId, viewer);
    const projectFilter = visible ? [inArray(projects.id, [...visible])] : [];

    // Projects the viewer can see (name / client).
    const projectRows = await this.db
      .select({ id: projects.id, name: projects.name, clientName: projects.clientName, color: projects.color, status: projects.status, spaceId: projects.spaceId })
      .from(projects)
      .where(and(eq(projects.organizationId, orgId), isNull(projects.archivedAt), sql`${projects.kind} <> 'internal'`, ...projectFilter, or(ilike(projects.name, like), ilike(projects.clientName, like))!))
      .limit(perGroup);

    // Space ids the viewer may read tasks from (null = everything).
    let spaceIds: string[] | null = null;
    if (visible) {
      const rows = visible.size ? await this.db.select({ spaceId: projects.spaceId }).from(projects).where(inArray(projects.id, [...visible])) : [];
      spaceIds = rows.map((r) => r.spaceId).filter((x): x is string => Boolean(x));
    }
    const taskScope = spaceIds ? (spaceIds.length ? [inArray(lists.spaceId, spaceIds)] : [sql`false`]) : [];

    const [taskRows, commentRows, contactRows, companyRows, messageRows, docRows] = await Promise.all([
      this.db
        .select({ id: tasks.id, reference: tasks.reference, title: tasks.title, listName: lists.name, status: statuses.name, dueDate: tasks.dueDate })
        .from(tasks)
        .innerJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(and(eq(tasks.organizationId, orgId), isNull(tasks.archivedAt), ...taskScope, or(ilike(tasks.title, like), ilike(tasks.reference, like), ilike(tasks.description, like))!))
        .orderBy(desc(tasks.updatedAt))
        .limit(perGroup),
      this.db
        .select({ id: comments.id, taskId: comments.taskId, body: comments.body, author: users.name, createdAt: comments.createdAt, taskTitle: tasks.title, reference: tasks.reference })
        .from(comments)
        .innerJoin(tasks, eq(tasks.id, comments.taskId))
        .innerJoin(lists, eq(lists.id, tasks.listId))
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(and(eq(comments.organizationId, orgId), isNull(tasks.archivedAt), ...taskScope, ilike(comments.body, like)))
        .orderBy(desc(comments.createdAt))
        .limit(perGroup),
      viewer.role === "guest"
        ? Promise.resolve([])
        : this.db
            .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone, title: contacts.title, companyId: contacts.companyId, company: companies.name })
            .from(contacts)
            .leftJoin(companies, eq(companies.id, contacts.companyId))
            .where(and(eq(contacts.organizationId, orgId), isNull(contacts.archivedAt), or(ilike(contacts.firstName, like), ilike(contacts.lastName, like), ilike(contacts.email, like), ilike(contacts.phone, like), ilike(contacts.title, like), sql`(${contacts.firstName} || ' ' || coalesce(${contacts.lastName}, '')) ilike ${like}`)!))
            .limit(perGroup),
      viewer.role === "guest"
        ? Promise.resolve([])
        : this.db
            .select({ id: companies.id, name: companies.name, website: companies.website, industry: companies.industry })
            .from(companies)
            .where(and(eq(companies.organizationId, orgId), isNull(companies.archivedAt), or(ilike(companies.name, like), ilike(companies.website, like), ilike(companies.industry, like))!))
            .limit(perGroup),
      this.db
        .select({ id: messages.id, channelId: messages.channelId, body: messages.body, author: users.name, createdAt: messages.createdAt, channelName: channels.name, projectName: projects.name })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        .innerJoin(channelMembers, and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, viewer.userId)))
        .leftJoin(projects, eq(projects.id, channels.projectId))
        .leftJoin(users, eq(users.id, messages.authorId))
        .where(and(eq(messages.organizationId, orgId), eq(messages.kind, "user"), ilike(messages.body, like)))
        .orderBy(desc(messages.createdAt))
        .limit(perGroup),
      this.searchDocs(orgId, viewer, q, like, perGroup),
    ]);

    const snippet = (text: string) => {
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, i - 40);
      const s = text.replace(/\s+/g, " ").slice(start, start + 140);
      return (start > 0 ? "…" : "") + s + (start + 140 < text.length ? "…" : "");
    };

    const groups = [
      { type: "task", label: "Tasks", items: taskRows.map((t) => ({ id: t.id, title: t.reference ? `${t.reference} ${t.title}` : t.title, subtitle: [t.listName, t.status].filter(Boolean).join(" · "), nav: { kind: "task", id: t.id } })) },
      { type: "project", label: "Projects", items: projectRows.map((p) => ({ id: p.id, title: p.name, subtitle: [p.clientName, p.status].filter(Boolean).join(" · "), color: p.color, nav: { kind: "project", id: p.id } })) },
      { type: "document", label: "Docs", items: docRows },
      { type: "contact", label: "Contacts", items: contactRows.map((c) => ({ id: c.id, title: [c.firstName, c.lastName].filter(Boolean).join(" "), subtitle: [c.title, c.company, c.email].filter(Boolean).join(" · "), nav: c.companyId ? { kind: "company", id: c.companyId } : { kind: "contacts" } })) },
      { type: "company", label: "Companies", items: companyRows.map((c) => ({ id: c.id, title: c.name, subtitle: [c.industry, c.website].filter(Boolean).join(" · "), nav: { kind: "company", id: c.id } })) },
      { type: "message", label: "Chat", items: messageRows.map((m) => ({ id: m.id, title: snippet(m.body), subtitle: `${m.author ?? "Someone"} in ${m.projectName ?? m.channelName ?? "chat"} · ${m.createdAt.toLocaleDateString()}`, nav: { kind: "channel", id: m.channelId, messageId: m.id } })) },
      { type: "comment", label: "Comments", items: commentRows.map((c) => ({ id: c.id, title: snippet(c.body), subtitle: `${c.author ?? "Someone"} on ${c.reference ? `${c.reference} ` : ""}${c.taskTitle} · ${c.createdAt.toLocaleDateString()}`, nav: { kind: "task", id: c.taskId } })) },
    ].filter((g) => g.items.length);
    return { q, groups, total: groups.reduce((a, g) => a + g.items.length, 0) };
  }

  /** Full-text over title + body (ranked), widened with a plain match so partial words still hit. Permissions via DocumentsService. */
  private async searchDocs(orgId: string, viewer: Viewer & { role: Role }, q: string, like: string, limit: number) {
    const allowed = await this.documents.list(orgId, { q }, viewer);
    if (!allowed.length) return [];
    const ids = allowed.map((d) => d.id);
    // Rank the permitted set with Postgres FTS; anything only the ILIKE found keeps rank 0 and sorts last.
    const ranked = await this.db.execute<{ id: string; rank: number; headline: string }>(sql`
      select d.id,
             ts_rank(to_tsvector('english', coalesce(d.title, '') || ' ' || coalesce(d.body, '')), plainto_tsquery('english', ${q})) as rank,
             ts_headline('english', coalesce(d.body, ''), plainto_tsquery('english', ${q}), 'MaxWords=18, MinWords=8, StartSel=«, StopSel=»') as headline
      from documents d
      where d.id in ${ids}
      order by rank desc, d.updated_at desc
      limit ${limit}
    `);
    const byId = new Map(allowed.map((d) => [d.id, d]));
    const rows = (ranked as unknown as { rows?: { id: string; rank: number; headline: string }[] }).rows ?? (ranked as unknown as { id: string; rank: number; headline: string }[]);
    return rows.map((r) => {
      const d = byId.get(r.id)!;
      const plain = d.excerpt.toLowerCase().includes(q.toLowerCase()) ? d.excerpt : r.headline?.replace(/«|»/g, "") || d.excerpt;
      return { id: d.id, title: `${d.icon ? `${d.icon} ` : ""}${d.title || "Untitled"}`, subtitle: [d.project?.name, plain.slice(0, 140)].filter(Boolean).join(" · "), nav: { kind: "document", id: d.id } };
    });
  }
}
