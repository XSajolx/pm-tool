import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, memberships, spaces, statuses, tags, taskAssignees, taskTags, tasks, users } from "../../db/schema.js";
import { parseCsv } from "../../common/csv.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ActivityService } from "../activity/activity.service.js";

/** The columns ClickUp puts in its CSV export (names vary slightly by version; we match loosely). */
const COL = {
  id: ["Task ID", "task_id", "ID"],
  name: ["Task Name", "Name", "task_name"],
  content: ["Task Content", "Description", "task_content"],
  status: ["Status", "status"],
  created: ["Date Created", "date_created"],
  due: ["Due Date", "due_date"],
  start: ["Start Date", "start_date"],
  parent: ["Parent ID", "parent_id", "Parent"],
  assignees: ["Assignees", "assignees"],
  tags: ["Tags", "tags"],
  priority: ["Priority", "priority"],
  list: ["List Name", "List", "list_name"],
  folder: ["Folder Name", "Folder", "folder_name"],
  space: ["Space Name", "Space", "space_name"],
  estimate: ["Time Estimated", "time_estimated", "Time Estimate"],
} as const;
type Field = keyof typeof COL;

interface Session { orgId: string; rows: Record<string, string>[]; headers: string[]; expires: number; filename: string }
export interface ListMapping { listId?: string; createIn?: { spaceId?: string; newSpaceName?: string; listName: string }; statuses?: Record<string, string> }

/**
 * Row 126: ClickUp CSV → our lists. Preview groups the export by
 * Space / Folder / List with status, assignee and tag counts; the admin maps
 * each ClickUp list to an existing list (or a new one) and each status to one
 * of the target space's statuses (or "create it"). Re-importing the same file
 * skips tasks already brought in (import_key).
 */
@Injectable()
export class ImportService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly workspace: WorkspaceService,
    private readonly activity: ActivityService,
  ) {}

  private col(headers: string[], f: Field) {
    const wanted = COL[f].map((x) => x.toLowerCase());
    return headers.find((h) => wanted.includes(h.toLowerCase())) ?? null;
  }
  private get(row: Record<string, string>, headers: string[], f: Field) {
    const c = this.col(headers, f);
    return c ? row[c] ?? "" : "";
  }
  private listKey(row: Record<string, string>, headers: string[]) {
    return [this.get(row, headers, "space"), this.get(row, headers, "folder"), this.get(row, headers, "list")].map((x) => x || "—").join(" / ");
  }

  async preview(orgId: string, file: { originalname: string; buffer: Buffer }) {
    const text = file.buffer.toString("utf8");
    const { headers, rows } = parseCsv(text);
    if (!rows.length) throw new BadRequestException("The file has no rows");
    if (!this.col(headers, "name")) throw new BadRequestException(`This doesn't look like a ClickUp export - no "Task Name" column. Columns found: ${headers.slice(0, 8).join(", ")}`);
    for (const [k, v] of this.sessions) if (v.expires < Date.now()) this.sessions.delete(k);
    const importId = randomBytes(12).toString("base64url");
    this.sessions.set(importId, { orgId, rows, headers, expires: Date.now() + 60 * 60_000, filename: file.originalname });

    // Existing structure, to suggest destinations.
    const [spaceRows, listRows, members, existingKeys] = await Promise.all([
      this.db.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(eq(spaces.organizationId, orgId), isNull(spaces.archivedAt))),
      this.db.select({ id: lists.id, name: lists.name, spaceId: lists.spaceId }).from(lists).where(and(eq(lists.organizationId, orgId), isNull(lists.archivedAt))),
      this.db.select({ id: users.id, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, orgId)),
      this.db.select({ importKey: tasks.importKey }).from(tasks).where(and(eq(tasks.organizationId, orgId), inArray(tasks.importKey, rows.map((r) => `clickup:${this.get(r, headers, "id")}`).filter((k) => k !== "clickup:")))),
    ]);
    const already = new Set(existingKeys.map((k) => k.importKey));

    const groups = new Map<string, { space: string; folder: string; list: string; count: number; already: number; statuses: Map<string, number>; sample: string[] }>();
    const assignees = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    let subtasks = 0;
    for (const row of rows) {
      const key = this.listKey(row, headers);
      const g = groups.get(key) ?? { space: this.get(row, headers, "space"), folder: this.get(row, headers, "folder"), list: this.get(row, headers, "list") || "Imported", count: 0, already: 0, statuses: new Map<string, number>(), sample: [] as string[] };
      g.count++;
      if (already.has(`clickup:${this.get(row, headers, "id")}`)) g.already++;
      const st = this.get(row, headers, "status") || "(none)";
      g.statuses.set(st, (g.statuses.get(st) ?? 0) + 1);
      if (g.sample.length < 3) g.sample.push(this.get(row, headers, "name"));
      groups.set(key, g);
      if (this.get(row, headers, "parent")) subtasks++;
      for (const a of splitList(this.get(row, headers, "assignees"))) assignees.set(a, (assignees.get(a) ?? 0) + 1);
      for (const t of splitList(this.get(row, headers, "tags"))) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const matchMember = (label: string) => {
      const l = label.toLowerCase();
      return members.find((m) => m.email.toLowerCase() === l || m.name.toLowerCase() === l || l.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(l))?.id ?? null;
    };
    return {
      importId,
      filename: file.originalname,
      totalRows: rows.length,
      subtasks,
      alreadyImported: already.size,
      columns: headers,
      lists: [...groups.entries()].map(([key, g]) => {
        const suggested = listRows.find((l) => l.name.toLowerCase() === g.list.toLowerCase());
        return {
          key,
          space: g.space,
          folder: g.folder,
          list: g.list,
          count: g.count,
          already: g.already,
          sample: g.sample,
          statuses: [...g.statuses.entries()].map(([name, count]) => ({ name, count })),
          suggestedListId: suggested?.id ?? null,
          suggestedSpaceId: suggested?.spaceId ?? spaceRows.find((s) => s.name.toLowerCase() === g.space.toLowerCase())?.id ?? null,
        };
      }),
      assignees: [...assignees.entries()].map(([label, count]) => ({ label, count, userId: matchMember(label) })),
      tags: [...tagCounts.entries()].map(([name, count]) => ({ name, count })),
      spaces: spaceRows,
      existingLists: listRows,
      members: members.map((m) => ({ id: m.id, name: m.name })),
    };
  }

  async run(orgId: string, userId: string, importId: string, mapping: Record<string, ListMapping>, assigneeMap: Record<string, string | null> = {}) {
    const session = this.sessions.get(importId);
    if (!session || session.orgId !== orgId) throw new NotFoundException("Preview expired - upload the file again");
    const { rows, headers } = session;
    const members = await this.db.select({ id: users.id, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, orgId));
    const memberByLabel = (label: string) => {
      if (label in assigneeMap) return assigneeMap[label] ?? null;
      const l = label.toLowerCase();
      return members.find((m) => m.email.toLowerCase() === l || m.name.toLowerCase() === l)?.id ?? null;
    };
    const existing = await this.db.select({ importKey: tasks.importKey, id: tasks.id }).from(tasks).where(and(eq(tasks.organizationId, orgId), inArray(tasks.importKey, rows.map((r) => `clickup:${this.get(r, headers, "id")}`))));
    const existingByKey = new Map(existing.map((e) => [e.importKey!, e.id]));

    // Resolve every ClickUp list to a target list + space, creating what the admin asked for.
    const targets = new Map<string, { listId: string; spaceId: string }>();
    const createdSpaces = new Map<string, string>();
    for (const [key, m] of Object.entries(mapping)) {
      if (m.listId) {
        const list = await this.db.query.lists.findFirst({ where: and(eq(lists.id, m.listId), eq(lists.organizationId, orgId)), columns: { id: true, spaceId: true } });
        if (!list) throw new BadRequestException(`Target list not found for "${key}"`);
        targets.set(key, { listId: list.id, spaceId: list.spaceId });
      } else if (m.createIn) {
        let spaceId = m.createIn.spaceId ?? null;
        if (!spaceId) {
          const name = (m.createIn.newSpaceName ?? "Imported from ClickUp").trim();
          spaceId = createdSpaces.get(name.toLowerCase()) ?? null;
          if (!spaceId) {
            const space = await this.workspace.createSpace(orgId, { name });
            spaceId = (space as { id: string }).id;
            createdSpaces.set(name.toLowerCase(), spaceId);
          }
        }
        const list = await this.workspace.createList(orgId, spaceId, m.createIn.listName.trim() || "Imported");
        targets.set(key, { listId: (list as { id: string }).id, spaceId });
      }
    }

    // Status resolution per target space (create missing ones with a sensible category).
    const statusCache = new Map<string, Map<string, string>>();
    const statusFor = async (key: string, spaceId: string, clickupStatus: string) => {
      const chosen = mapping[key]?.statuses?.[clickupStatus];
      if (chosen && chosen !== "create") return chosen;
      let cache = statusCache.get(spaceId);
      if (!cache) {
        const rowsS = await this.db.select({ id: statuses.id, name: statuses.name }).from(statuses).where(and(eq(statuses.spaceId, spaceId), eq(statuses.organizationId, orgId)));
        cache = new Map(rowsS.map((s) => [s.name.toLowerCase(), s.id]));
        statusCache.set(spaceId, cache);
      }
      const name = clickupStatus || "To Do";
      const hit = cache.get(name.toLowerCase());
      if (hit) return hit;
      const created = await this.workspace.createStatus(orgId, spaceId, { name, category: guessCategory(name) });
      cache.set(name.toLowerCase(), (created as { id: string }).id);
      return (created as { id: string }).id;
    };

    // Tags (workspace-level).
    const tagRows = await this.db.select({ id: tags.id, name: tags.name }).from(tags).where(and(eq(tags.organizationId, orgId), isNull(tags.archivedAt)));
    const tagByName = new Map(tagRows.map((t) => [t.name.toLowerCase(), t.id]));
    const tagFor = async (name: string) => {
      const hit = tagByName.get(name.toLowerCase());
      if (hit) return hit;
      const created = await this.workspace.createTag(orgId, { name });
      tagByName.set(name.toLowerCase(), (created as { id: string }).id);
      return (created as { id: string }).id;
    };

    // Parents first, then subtasks; skip rows already imported or whose list wasn't mapped.
    const idMap = new Map<string, string>(existingByKey.entries() as Iterable<[string, string]>);
    const ordered = [...rows.filter((r) => !this.get(r, headers, "parent")), ...rows.filter((r) => this.get(r, headers, "parent"))];
    const result = { created: 0, skipped: 0, subtasks: 0, assigned: 0, tagged: 0, unmappedLists: new Set<string>(), errors: [] as string[] };
    for (const row of ordered) {
      const key = this.listKey(row, headers);
      const target = targets.get(key);
      if (!target) { result.unmappedLists.add(key); result.skipped++; continue; }
      const cuId = this.get(row, headers, "id");
      const importKey = cuId ? `clickup:${cuId}` : null;
      if (importKey && existingByKey.has(importKey)) { result.skipped++; continue; }
      try {
        const parentCu = this.get(row, headers, "parent");
        const parentTaskId = parentCu ? idMap.get(`clickup:${parentCu}`) ?? null : null;
        const statusId = await statusFor(key, target.spaceId, this.get(row, headers, "status"));
        const [task] = await this.db
          .insert(tasks)
          .values({
            organizationId: orgId,
            listId: target.listId,
            title: (this.get(row, headers, "name") || "Untitled").slice(0, 500),
            description: this.get(row, headers, "content") || null,
            statusId,
            priority: mapPriority(this.get(row, headers, "priority")),
            parentTaskId,
            startDate: parseDate(this.get(row, headers, "start")),
            dueDate: parseDate(this.get(row, headers, "due")),
            timeEstimateMinutes: parseMinutes(this.get(row, headers, "estimate")),
            createdById: userId,
            importKey,
            createdAt: parseDate(this.get(row, headers, "created")) ?? undefined,
          })
          .returning({ id: tasks.id });
        if (importKey) idMap.set(importKey, task!.id);
        result.created++;
        if (parentTaskId) result.subtasks++;
        const assigneeIds = [...new Set(splitList(this.get(row, headers, "assignees")).map(memberByLabel).filter((x): x is string => Boolean(x)))];
        if (assigneeIds.length) {
          await this.db.insert(taskAssignees).values(assigneeIds.map((uid) => ({ organizationId: orgId, taskId: task!.id, userId: uid }))).onConflictDoNothing();
          result.assigned += assigneeIds.length;
        }
        const tagNames = splitList(this.get(row, headers, "tags"));
        for (const t of tagNames) {
          await this.db.insert(taskTags).values({ taskId: task!.id, tagId: await tagFor(t) }).onConflictDoNothing();
          result.tagged++;
        }
      } catch (err) {
        result.errors.push(`${this.get(row, headers, "name") || cuId}: ${(err as Error).message}`);
      }
    }
    await this.activity.record({ orgId, actorId: userId, entityType: "workspace", entityId: orgId, action: "clickup_import", changes: [{ field: "file", from: null, to: session.filename }, { field: "created", from: null, to: result.created }, { field: "skipped", from: null, to: result.skipped }] });
    this.sessions.delete(importId);
    return { ...result, unmappedLists: [...result.unmappedLists], errors: result.errors.slice(0, 20) };
  }
}

function splitList(v: string) {
  return v.split(/[,;]/).map((x) => x.trim().replace(/^\[|\]$/g, "").trim()).filter(Boolean);
}
function parseDate(v: string): Date | null {
  if (!v) return null;
  if (/^\d{11,}$/.test(v)) return new Date(Number(v));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function parseMinutes(v: string): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.round(Number(v) / 60000) || null; // ClickUp exports milliseconds
  const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(v);
  const mins = (Number(m?.[1] ?? 0) * 60) + Number(m?.[2] ?? 0);
  return mins || null;
}
function mapPriority(v: string): "urgent" | "high" | "normal" | "low" | null {
  const l = v.toLowerCase();
  if (!l || l === "null" || l === "none") return null;
  if (l.includes("urgent") || l === "1") return "urgent";
  if (l.includes("high") || l === "2") return "high";
  if (l.includes("low") || l === "4") return "low";
  return "normal";
}
function guessCategory(name: string): "not_started" | "active" | "done" | "closed" {
  const l = name.toLowerCase();
  if (/(done|complete|closed|finished|shipped|released|resolved)/.test(l)) return "done";
  if (/(to ?do|open|backlog|new|not started|todo|planned)/.test(l)) return "not_started";
  if (/(cancel|archiv|won'?t)/.test(l)) return "closed";
  return "active";
}
