import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { AutomationsService, TRIGGERS } from "./automations.service.js";

const triggerSchema = z.object({ type: z.enum(["task_created", "task_status_changed", "task_completed", "expense_approved", "invoice_overdue", "invoice_paid", "stage_completed", "milestone_reached", "deal_stage_changed"]), toName: z.string().max(120).nullable().optional() });
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), to: z.enum(["admins", "project_lead", "assignees", "rule_owner", "user"]), userId: z.string().uuid().nullable().optional(), message: z.string().min(1).max(500) }),
  z.object({ type: z.literal("assign"), userId: z.string().uuid() }),
  z.object({ type: z.literal("move"), statusName: z.string().min(1).max(64) }),
  z.object({ type: z.literal("create_task"), title: z.string().min(1).max(500), assigneeId: z.string().uuid().nullable().optional(), dueInDays: z.number().int().min(0).max(365).nullable().optional(), listId: z.string().uuid().nullable().optional() }),
]);
const ruleSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  ownerId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  trigger: triggerSchema.optional(),
  actions: z.array(actionSchema).min(1).max(10).optional(),
});
const testSchema = z.object({ entityType: z.string().min(1).max(32), entityId: z.string().uuid() });

/** Rows 153-155. Rules are owner/admin work; the trail on a record is readable by anyone who can see the record. */
@Controller("automations")
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get("triggers")
  triggers() {
    return TRIGGERS;
  }

  /** Row 155: what automations did to one record. */
  @Get("trail")
  trail(@Auth() auth: AuthContext, @Query("entityType") entityType: string, @Query("entityId") entityId: string) {
    return this.automations.runsFor(auth.orgId, entityType, entityId);
  }

  @Get()
  @Roles("owner", "admin")
  list(@Auth() auth: AuthContext) {
    return this.automations.list(auth.orgId);
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.automations.get(auth.orgId, id);
  }

  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(ruleSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof ruleSchema>) {
    return this.automations.create(auth.orgId, auth.userId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(ruleSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof ruleSchema>) {
    return this.automations.update(auth.orgId, auth.userId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.automations.remove(auth.orgId, auth.userId, id);
  }

  @Post(":id/test")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(testSchema))
  test(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof testSchema>) {
    return this.automations.testRun(auth.orgId, id, dto);
  }

  @Post("sweep-overdue")
  @Roles("owner", "admin")
  sweep() {
    return this.automations.sweepOverdue().then(() => ({ ok: true }));
  }
}
