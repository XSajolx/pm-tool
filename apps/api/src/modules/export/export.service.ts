import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { comments, companies, contacts, deals, documents, lists, memberships, milestones, organizations, projectStages, projects, statuses, taskAssignees, taskTags, tags, tasks, timeEntries, users } from "../../db/schema.js";
import { toCsv, zipFiles } from "../../common/zip.js";

/**
 * Row 117: everything the workspace owns, as one ZIP: a full JSON snapshot plus
 * one CSV per table people actually open in a spreadsheet. Scope it to one
 * project to hand a client or archive a job.
 */
@Injectable()
export class ExportService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async build(orgId: string, projectId?: string) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { id: true, name: true, slug: true } });
    if (!org) throw new NotFoundException("Workspace not found");
    let project: typeof projects.$inferSelect | undefined;
    if (projectId) {
      project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)) });
      if (!project) throw new NotFoundException("Project not found");
    }

    const projectRows = project ? [project] : await this.db.query.projects.findMany({ where: eq(projects.organizationId, orgId) });
    const projectIds = projectRows.map((p) => p.id);
    const spaceIds = projectRows.map((p) => p.spaceId).filter((x): x is string => Boolean(x));
    const listRows = project
      ? spaceIds.length ? await this.db.query.lists.findMany({ where: inArray(lists.spaceId, spaceIds) }) : []
      : await this.db.query.lists.findMany({ where: eq(lists.organizationId, orgId) });
    const listIds = listRows.map((l) => l.id);
    const taskRows = listIds.length ? await this.db.query.tasks.findMany({ where: and(eq(tasks.organizationId, orgId), inArray(tasks.listId, listIds), isNull(tasks.archivedAt)) }) : [];
    const taskIds = taskRows.map((t) => t.id);
    const [assignees, tagLinks, tagRows, statusRows, commentRows, docRows, timeRows, msRows, stageRows, companyRows, contactRows, dealRows, memberRows] = await Promise.all([
      taskIds.length ? this.db.select().from(taskAssignees).where(inArray(taskAssignees.taskId, taskIds)) : [],
      taskIds.length ? this.db.select().from(taskTags).where(inArray(taskTags.taskId, taskIds)) : [],
      this.db.select().from(tags).where(eq(tags.organizationId, orgId)),
      this.db.select().from(statuses).where(eq(statuses.organizationId, orgId)),
      taskIds.length ? this.db.select().from(comments).where(inArray(comments.taskId, taskIds)) : [],
      project
        ? this.db.query.documents.findMany({ where: and(eq(documents.organizationId, orgId), eq(documents.projectId, project.id), isNull(documents.archivedAt)) })
        : this.db.query.documents.findMany({ where: and(eq(documents.organizationId, orgId), isNull(documents.archivedAt)) }),
      project
        ? this.db.query.timeEntries.findMany({ where: and(eq(timeEntries.organizationId, orgId), eq(timeEntries.projectId, project.id), isNull(timeEntries.archivedAt)) })
        : this.db.query.timeEntries.findMany({ where: and(eq(timeEntries.organizationId, orgId), isNull(timeEntries.archivedAt)) }),
      projectIds.length ? this.db.query.milestones.findMany({ where: and(inArray(milestones.projectId, projectIds), isNull(milestones.archivedAt)) }) : [],
      projectIds.length ? this.db.query.projectStages.findMany({ where: and(inArray(projectStages.projectId, projectIds), isNull(projectStages.archivedAt)) }) : [],
      project
        ? project.companyId ? this.db.query.companies.findMany({ where: eq(companies.id, project.companyId) }) : []
        : this.db.query.companies.findMany({ where: and(eq(companies.organizationId, orgId), isNull(companies.archivedAt)) }),
      project
        ? project.companyId ? this.db.query.contacts.findMany({ where: eq(contacts.companyId, project.companyId) }) : []
        : this.db.query.contacts.findMany({ where: and(eq(contacts.organizationId, orgId), isNull(contacts.archivedAt)) }),
      project ? this.db.query.deals.findMany({ where: eq(deals.projectId, project.id) }) : this.db.query.deals.findMany({ where: eq(deals.organizationId, orgId) }),
      this.db.select({ userId: memberships.userId, role: memberships.role, name: users.name, email: users.email, weeklyCapacityHours: memberships.weeklyCapacityHours }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, orgId)),
    ]);

    const nameOf = new Map(memberRows.map((m) => [m.userId, m.name]));
    const statusName = new Map(statusRows.map((s) => [s.id, s.name]));
    const tagName = new Map(tagRows.map((t) => [t.id, t.name]));
    const listName = new Map(listRows.map((l) => [l.id, l.name]));
    const projectBySpace = new Map(projectRows.filter((p) => p.spaceId).map((p) => [p.spaceId!, p]));
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
    const taskRef = new Map(taskRows.map((t) => [t.id, t.reference ?? t.id]));
    const assigneesOf = (id: string) => assignees.filter((a) => a.taskId === id).map((a) => nameOf.get(a.userId) ?? a.userId);
    const tagsOf = (id: string) => tagLinks.filter((a) => a.taskId === id).map((a) => tagName.get(a.tagId) ?? a.tagId);

    const exportedAt = new Date().toISOString();
    const scope = project ? { kind: "project", projectId: project.id, name: project.name } : { kind: "workspace" };
    const json = {
      exportedAt,
      scope,
      workspace: org,
      members: memberRows,
      projects: projectRows,
      lists: listRows,
      statuses: statusRows,
      tags: tagRows,
      tasks: taskRows.map((t) => ({ ...t, assignees: assigneesOf(t.id), tags: tagsOf(t.id) })),
      comments: commentRows,
      documents: docRows,
      milestones: msRows,
      stages: stageRows,
      timeEntries: timeRows,
      companies: companyRows,
      contacts: contactRows,
      deals: dealRows,
    };

    const tasksCsv = taskRows.map((t) => {
      const list = listRows.find((l) => l.id === t.listId);
      const proj = list ? projectBySpace.get(list.spaceId) : undefined;
      return {
        reference: t.reference, title: t.title, project: proj?.name ?? "", list: listName.get(t.listId) ?? "", status: statusName.get(t.statusId ?? "") ?? "",
        priority: t.priority, assignees: assigneesOf(t.id).join("; "), tags: tagsOf(t.id).join("; "), startDate: t.startDate, dueDate: t.dueDate, completedAt: t.completedAt,
        estimateMinutes: t.timeEstimateMinutes, createdAt: t.createdAt, description: t.description,
      };
    });
    const files = [
      { name: "README.txt", data: `PM Tool export\nWorkspace: ${org.name}\nScope: ${project ? `project "${project.name}"` : "whole workspace"}\nExported: ${exportedAt}\n\nexport.json holds everything (ids included) for re-import or scripting.\nThe CSV files are the same data flattened for spreadsheets.\n` },
      { name: "export.json", data: JSON.stringify(json, null, 2) },
      { name: "projects.csv", data: toCsv(projectRows.map((p) => ({ name: p.name, status: p.status, kind: p.kind, client: p.clientName, lead: p.leadId ? nameOf.get(p.leadId) ?? "" : "", startDate: p.startDate, endDate: p.endDate, budgetHours: p.budgetHours, budgetAmount: p.budgetAmount, currency: p.currency, createdAt: p.createdAt }))) },
      { name: "tasks.csv", data: toCsv(tasksCsv) },
      { name: "comments.csv", data: toCsv(commentRows.map((c) => ({ task: taskRef.get(c.taskId) ?? c.taskId, author: nameOf.get(c.authorId ?? "") ?? "", body: c.body, createdAt: c.createdAt }))) },
      { name: "documents.csv", data: toCsv(docRows.map((d) => ({ title: d.title, project: d.projectId ? projectName.get(d.projectId) ?? "" : "", reviewStatus: d.reviewStatus, updatedAt: d.updatedAt, body: d.body }))) },
      { name: "milestones.csv", data: toCsv(msRows.map((m) => ({ project: projectName.get(m.projectId) ?? "", name: m.name, targetDate: m.targetDate, reachedAt: m.reachedAt, clientVisible: m.clientVisible }))) },
      { name: "stages.csv", data: toCsv(stageRows.map((s) => ({ project: projectName.get(s.projectId) ?? "", name: s.name, status: s.status, progressPct: s.progressPct, startedAt: s.startedAt, completedAt: s.completedAt }))) },
      { name: "time_entries.csv", data: toCsv(timeRows.map((e) => ({ person: nameOf.get(e.userId) ?? e.userId, project: e.projectId ? projectName.get(e.projectId) ?? "" : "", task: e.taskId ? taskRef.get(e.taskId) ?? "" : "", startedAt: e.startedAt, endedAt: e.endedAt, hours: Math.round(((e.durationSeconds ?? 0) / 3600) * 100) / 100, billable: e.billable, note: e.description, source: e.source }))) },
      { name: "companies.csv", data: toCsv(companyRows.map((c) => ({ name: c.name, website: c.website, industry: c.industry, createdAt: c.createdAt }))) },
      { name: "contacts.csv", data: toCsv(contactRows.map((c) => ({ firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, title: c.title, company: companyRows.find((x) => x.id === c.companyId)?.name ?? "" }))) },
      { name: "deals.csv", data: toCsv(dealRows.map((d) => ({ title: d.title, value: d.value, currency: d.currency, probability: d.probability, expectedCloseDate: d.expectedCloseDate, closedAt: d.closedAt, lostReason: d.lostReason }))) },
      { name: "members.csv", data: toCsv(memberRows.map((m) => ({ name: m.name, email: m.email, role: m.role, weeklyCapacityHours: m.weeklyCapacityHours }))) },
    ];
    const slug = (project ? project.name : org.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
    return { filename: `${slug}-export-${exportedAt.slice(0, 10)}.zip`, bytes: zipFiles(files), counts: { projects: projectRows.length, tasks: taskRows.length, documents: docRows.length, timeEntries: timeRows.length, contacts: contactRows.length } };
  }
}
