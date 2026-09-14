import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, projectMembers, projects, tasks } from "../../db/schema.js";

export interface Viewer {
  userId: string;
  role: string;
}

/**
 * Row 84: per-project access. Owners and project managers (admins) see every
 * project. Team members and client guests see only projects they're on - as a
 * project member, its lead or its creator. Everything else about a project
 * they're not on answers "not found", never "no permission", so its existence
 * isn't leaked. Spaces that belong to no project stay visible to team members
 * (they're the workspace's shared lists) but not to guests.
 */
@Injectable()
export class ProjectAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  isAdmin(viewer: Viewer) {
    return viewer.role === "owner" || viewer.role === "admin";
  }

  /** `null` = unrestricted (admins). */
  async visibleProjectIds(orgId: string, viewer: Viewer): Promise<Set<string> | null> {
    if (this.isAdmin(viewer)) return null;
    const [memberOf, ledOrMade] = await Promise.all([
      this.db.query.projectMembers.findMany({ where: and(eq(projectMembers.organizationId, orgId), eq(projectMembers.userId, viewer.userId)), columns: { projectId: true } }),
      this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), or(eq(projects.leadId, viewer.userId), eq(projects.createdById, viewer.userId))), columns: { id: true } }),
    ]);
    return new Set([...memberOf.map((m) => m.projectId), ...ledOrMade.map((p) => p.id)]);
  }

  async canSeeProject(orgId: string, viewer: Viewer, projectId: string) {
    const visible = await this.visibleProjectIds(orgId, viewer);
    return visible === null || visible.has(projectId);
  }

  async assertProject(orgId: string, viewer: Viewer, projectId: string) {
    if (!(await this.canSeeProject(orgId, viewer, projectId))) throw new NotFoundException("Project not found");
  }

  /** The project wrapping a space, if any. */
  async projectIdForSpace(orgId: string, spaceId: string) {
    const p = await this.db.query.projects.findFirst({ where: and(eq(projects.organizationId, orgId), eq(projects.spaceId, spaceId), isNull(projects.archivedAt)), columns: { id: true } });
    return p?.id ?? null;
  }

  /** A space is visible when its project is, or when it has no project (team members only). */
  async canSeeSpace(orgId: string, viewer: Viewer, spaceId: string) {
    if (this.isAdmin(viewer)) return true;
    const projectId = await this.projectIdForSpace(orgId, spaceId);
    if (!projectId) return viewer.role !== "guest";
    return this.canSeeProject(orgId, viewer, projectId);
  }

  async assertSpace(orgId: string, viewer: Viewer, spaceId: string) {
    if (!(await this.canSeeSpace(orgId, viewer, spaceId))) throw new NotFoundException("Space not found");
  }

  async assertList(orgId: string, viewer: Viewer, listId: string) {
    if (this.isAdmin(viewer)) return;
    const l = await this.db.query.lists.findFirst({ where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)), columns: { spaceId: true } });
    if (!l) throw new NotFoundException("List not found");
    if (!(await this.canSeeSpace(orgId, viewer, l.spaceId))) throw new NotFoundException("List not found");
  }

  async assertTask(orgId: string, viewer: Viewer, taskId: string) {
    if (this.isAdmin(viewer)) return;
    const t = await this.db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.organizationId, orgId)), columns: { listId: true } });
    if (!t) throw new NotFoundException("Task not found");
    try {
      await this.assertList(orgId, viewer, t.listId);
    } catch {
      throw new NotFoundException("Task not found");
    }
  }

  /** Keep only the spaces the viewer may see (sidebar tree, overview lists). */
  async filterSpaceIds(orgId: string, viewer: Viewer, spaceIds: string[]) {
    if (this.isAdmin(viewer) || !spaceIds.length) return new Set(spaceIds);
    const visible = await this.visibleProjectIds(orgId, viewer);
    const owned = await this.db.query.projects.findMany({ where: and(eq(projects.organizationId, orgId), inArray(projects.spaceId, spaceIds), isNull(projects.archivedAt)), columns: { id: true, spaceId: true } });
    const projectBySpace = new Map(owned.map((p) => [p.spaceId!, p.id]));
    return new Set(spaceIds.filter((id) => {
      const projectId = projectBySpace.get(id);
      if (!projectId) return viewer.role !== "guest";
      return visible!.has(projectId);
    }));
  }
}
