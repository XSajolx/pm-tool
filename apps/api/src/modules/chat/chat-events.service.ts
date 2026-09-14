import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, projects } from "../../db/schema.js";
import { ChatGateway } from "./chat.gateway.js";
import { ChatService } from "./chat.service.js";

export type ProjectEventListener = (orgId: string, projectId: string, actorId: string, event: ProjectEvent) => Promise<unknown> | unknown;

export interface ProjectEvent {
  type: "task_completed" | "stage_changed" | "milestone_reached" | "doc_shared" | "doc_created" | "task_created";
  /** Written after the actor's name: "completed PM-12 Fix login". */
  text: string;
  link?: string;
  entityId?: string;
}

/**
 * Row 50: key project events (task completed, stage changed, milestone
 * reached, doc shared) become compact system lines in the project's channel,
 * so the team sees progress without opening dashboards. Off per channel via
 * `channels.activity_feed`. Never throws — chat noise must not fail the
 * action that caused it.
 */
@Injectable()
export class ChatEventsService {
  private readonly logger = new Logger(ChatEventsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly chat: ChatService,
    private readonly gateway: ChatGateway,
  ) {}

  private readonly listeners: ProjectEventListener[] = [];

  /** Row 77: other modules (notifications) subscribe to every project event without a circular import. */
  onProjectEvent(fn: ProjectEventListener) {
    this.listeners.push(fn);
  }

  async postProjectEvent(orgId: string, projectId: string, actorId: string, event: ProjectEvent) {
    for (const fn of this.listeners) {
      try {
        await fn(orgId, projectId, actorId, event);
      } catch (err) {
        this.logger.warn(`project event listener failed: ${(err as Error).message}`);
      }
    }
    try {
      const ch = await this.chat.projectChannel(orgId, projectId);
      if (!ch || !ch.activityFeed) return;
      const msg = await this.chat.postSystem(orgId, ch.id, actorId, event);
      this.gateway.broadcast(ch.id, msg);
    } catch (err) {
      this.logger.warn(`activity line not posted: ${(err as Error).message}`);
    }
  }

  /** Same, starting from a task's list (list → space → project). */
  async postForList(orgId: string, listId: string, actorId: string, event: ProjectEvent) {
    try {
      const list = await this.db.query.lists.findFirst({ where: and(eq(lists.id, listId), eq(lists.organizationId, orgId)), columns: { spaceId: true } });
      if (!list) return;
      const project = await this.db.query.projects.findFirst({ where: and(eq(projects.spaceId, list.spaceId), eq(projects.organizationId, orgId)), columns: { id: true } });
      if (!project) return;
      await this.postProjectEvent(orgId, project.id, actorId, event);
    } catch (err) {
      this.logger.warn(`activity line not posted: ${(err as Error).message}`);
    }
  }
}
