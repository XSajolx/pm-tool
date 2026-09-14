import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { TasksService } from "./tasks.service.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { createTaskSchema, updateTaskSchema, type CreateTaskDto, type UpdateTaskDto, bulkUpdateSchema, type BulkUpdateDto } from "./tasks.dto.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { CommentsService } from "../comments/comments.service.js";

const commentSchema = z.object({
  body: z.string().min(1).max(10_000),
  mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
  assigneeId: z.string().uuid().optional(),
  parentCommentId: z.string().uuid().optional(),
});
const relationSchema = z.object({
  relatedTaskId: z.string().uuid(),
  relation: z.enum(["blocks", "blocked_by", "duplicates", "relates_to"]),
});

/**
 * Identity comes from `@Auth()`, populated by the global guards from a verified
 * Supabase token plus a membership lookup. Reads are open to any member of the
 * org (guests included); writes exclude guests; deleting is admin/owner only.
 */
@Controller("tasks")
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly notifications: NotificationsService,
    private readonly comments: CommentsService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  async list(@Auth() auth: AuthContext, @Query("listId") listId: string) {
    // Row 84: a list in a project you're not on is "not found".
    await this.access.assertList(auth.orgId, auth, listId);
    return this.tasks.listByList(auth.orgId, listId);
  }

  /** Declared before ":id" so the literal path wins the match. */
  @Get("mine")
  mine(@Auth() auth: AuthContext, @Query("includeDone") includeDone?: string) {
    return this.tasks.mine(auth.orgId, auth.userId, includeDone === "true");
  }

  /** Follow-ups attached to a company, contact or deal (row 38). */
  @Get("crm")
  forCrm(
    @Auth() auth: AuthContext,
    @Query("companyId") companyId?: string,
    @Query("contactId") contactId?: string,
    @Query("dealId") dealId?: string,
  ) {
    return this.tasks.forCrm(auth.orgId, { companyId, contactId, dealId });
  }

  @Post(":id/complete")
  @Roles("owner", "admin", "member")
  async complete(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.access.assertCanContributeTask(auth.orgId, auth, id);
    return this.tasks.complete(auth.orgId, auth.userId, id);
  }

  @Post(":id/reopen")
  @Roles("owner", "admin", "member")
  async reopen(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.access.assertCanContributeTask(auth.orgId, auth, id);
    return this.tasks.reopen(auth.orgId, auth.userId, id);
  }

  @Get(":id")
  async findOne(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.access.assertTask(auth.orgId, auth, id);
    return this.tasks.findOne(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createTaskSchema))
  async create(@Auth() auth: AuthContext, @Body() dto: CreateTaskDto) {
    await this.access.assertCanContributeList(auth.orgId, auth, dto.listId);
    return this.tasks.create(auth.orgId, auth.userId, dto);
  }

  /** Declared before ":id" so "bulk" is not read as a task id. */
  @Patch("bulk")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(bulkUpdateSchema))
  bulk(@Auth() auth: AuthContext, @Body() dto: BulkUpdateDto) {
    return this.tasks.bulkUpdate(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(updateTaskSchema))
  async update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    // Row 85: viewers on the project can't change tasks.
    await this.access.assertCanContributeTask(auth.orgId, auth, id);
    return this.tasks.update(auth.orgId, auth.userId, id, dto);
  }

  @Post(":id/assignees")
  @Roles("owner", "admin", "member")
  addAssignee(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: { userId: string },
  ) {
    return this.tasks.addAssignee(auth.orgId, auth.userId, id, body.userId);
  }

  @Delete(":id/assignees/:userId")
  @Roles("owner", "admin", "member")
  removeAssignee(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Param("userId") userId: string,
  ) {
    return this.tasks.removeAssignee(auth.orgId, auth.userId, id, userId);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.tasks.remove(auth.orgId, auth.userId, id);
  }

  /* ---- Activity & comments ---- */

  /** Field-level history: who changed what, and from what to what. */
  @Get(":id/activity")
  activity(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.tasks.activityFor(auth.orgId, id);
  }

  @Post(":id/comments")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(commentSchema))
  async comment(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof commentSchema>,
  ) {
    await this.access.assertCanContributeTask(auth.orgId, auth, id);
    return this.comments.create(auth.orgId, auth.userId, id, dto);
  }

  /* ---- Relations ---- */

  @Get(":id/relations")
  relations(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.tasks.relationsFor(auth.orgId, id);
  }

  @Post(":id/relations")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(relationSchema))
  addRelation(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof relationSchema>,
  ) {
    return this.tasks.addRelation(
      auth.orgId,
      auth.userId,
      id,
      dto.relatedTaskId,
      dto.relation,
    );
  }

  @Delete(":id/relations/:relationId")
  @Roles("owner", "admin", "member")
  removeRelation(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Param("relationId") relationId: string,
  ) {
    return this.tasks.removeRelation(auth.orgId, auth.userId, id, relationId);
  }

  /* ---- Tags ---- */

  @Post(":id/tags")
  @Roles("owner", "admin", "member")
  addTag(@Auth() auth: AuthContext, @Param("id") id: string, @Body() body: { tagId: string }) {
    return this.tasks.addTag(auth.orgId, auth.userId, id, body.tagId);
  }

  @Delete(":id/tags/:tagId")
  @Roles("owner", "admin", "member")
  removeTag(@Auth() auth: AuthContext, @Param("id") id: string, @Param("tagId") tagId: string) {
    return this.tasks.removeTag(auth.orgId, auth.userId, id, tagId);
  }

  /* ---- Following ---- */

  @Get(":id/subscription")
  async subscription(@Auth() auth: AuthContext, @Param("id") id: string) {
    return { subscribed: await this.notifications.isSubscribed(id, auth.userId) };
  }

  @Post(":id/subscribe")
  async subscribe(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.notifications.subscribe(auth.orgId, id, auth.userId);
    return { subscribed: true };
  }

  @Delete(":id/subscribe")
  async unsubscribe(@Auth() auth: AuthContext, @Param("id") id: string) {
    await this.notifications.unsubscribe(id, auth.userId);
    return { subscribed: false };
  }
}
