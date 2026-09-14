import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { TimeService } from "./time.service.js";
import { TimeCodesService } from "./time-codes.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const startSchema = z.object({
  /** Row 90: optional when taskId is given. */
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  /** Row 87 */
  stageId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
  billable: z.boolean().optional(),
});

const manualSchema = startSchema.extend({
  projectId: z.string().uuid(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().positive().optional(),
});

const updateSchema = z.object({
  description: z.string().max(2000).optional(),
  billable: z.boolean().optional(),
  durationSeconds: z.number().int().positive().optional(),
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().nullable().optional(),
  stageId: z.string().uuid().nullable().optional(),
});

const cellSchema = z.object({
  projectId: z.string().uuid(),
  /** Row 88: optional task row. */
  taskId: z.string().uuid().nullable().optional(),
  /** Any ISO date inside the target day. */
  date: z.string().min(8),
  hours: z.number().min(0).max(24),
  userId: z.string().uuid().optional(),
});

const WRITERS = ["owner", "admin", "member"] as const;
/** Row 91 */
const codeSchema = z.object({ name: z.string().min(1).max(64), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
const codePatchSchema = z.object({ name: z.string().min(1).max(64).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), archived: z.boolean().optional() });
/** Row 75 */
const submitSchema = z.object({ week: z.string().min(8), approverId: z.string().uuid().optional() });
const decisionSchema = z.object({ approve: z.boolean(), note: z.string().max(2000).optional() });

@Controller("time")
export class TimeController {
  constructor(
    private readonly time: TimeService,
    private readonly codes: TimeCodesService,
  ) {}

  /* ---- Row 91: internal time codes ---- */

  @Get("codes")
  listCodes(@Auth() auth: AuthContext, @Query("includeArchived") includeArchived?: string) {
    return this.codes.list(auth.orgId, includeArchived === "true");
  }

  @Post("codes")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(codeSchema))
  createCode(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof codeSchema>) {
    return this.codes.create(auth.orgId, dto.name, dto.color);
  }

  @Patch("codes/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(codePatchSchema))
  updateCode(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof codePatchSchema>) {
    return this.codes.update(auth.orgId, id, dto);
  }

  private actor(auth: AuthContext) {
    return { userId: auth.userId, role: auth.role };
  }

  /* ---- timer ---- */

  @Get("running")
  running(@Auth() auth: AuthContext) {
    return this.time.running(auth.orgId, auth.userId);
  }

  @Post("start")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(startSchema))
  start(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof startSchema>) {
    return this.time.start(auth.orgId, auth.userId, dto);
  }

  @Post("stop")
  @Roles(...WRITERS)
  stop(@Auth() auth: AuthContext) {
    return this.time.stop(auth.orgId, auth.userId);
  }

  /* ---- entries ---- */

  @Get("entries")
  entries(
    @Auth() auth: AuthContext,
    @Query("userId") userId?: string,
    @Query("projectId") projectId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.time.list(auth.orgId, this.actor(auth), { userId, projectId, from, to });
  }

  /** Row 87: tasks you can log time against in a project. */
  @Get("pickable-tasks")
  pickableTasks(@Auth() auth: AuthContext, @Query("projectId") projectId: string) {
    return projectId ? this.time.pickableTasks(auth.orgId, projectId) : [];
  }

  @Post("entries")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(manualSchema))
  createManual(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof manualSchema>) {
    return this.time.createManual(auth.orgId, auth.userId, dto);
  }

  @Patch("entries/:id")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(updateSchema))
  update(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof updateSchema>,
  ) {
    return this.time.update(auth.orgId, this.actor(auth), id, dto);
  }

  @Delete("entries/:id")
  @Roles(...WRITERS)
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.time.remove(auth.orgId, this.actor(auth), id);
  }

  /* ---- timesheet ---- */

  /** `?week=` is any date in the week; `?userId=` needs admin. */
  @Get("timesheet")
  timesheet(
    @Auth() auth: AuthContext,
    @Query("week") week?: string,
    @Query("userId") userId?: string,
  ) {
    return this.time.timesheet(
      auth.orgId,
      this.actor(auth),
      week ?? new Date().toISOString(),
      userId,
    );
  }

  /** Row 75: submit a week for approval - the approver gets an inbox card. */
  @Post("timesheet/submit")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(submitSchema))
  submit(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof submitSchema>) {
    return this.time.submitWeek(auth.orgId, this.actor(auth), dto.week, dto.approverId);
  }

  @Post("timesheet/submissions/:id/decision")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(decisionSchema))
  decideSubmission(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.time.decideTimesheet(auth.orgId, this.actor(auth), id, dto.approve, dto.note);
  }

  @Put("timesheet")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(cellSchema))
  setCell(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof cellSchema>) {
    return this.time.setTimesheetCell(auth.orgId, this.actor(auth), dto);
  }

  /* ---- summaries ---- */

  @Get("summary/:projectId")
  summary(@Auth() auth: AuthContext, @Param("projectId") projectId: string) {
    return this.time.projectSummary(auth.orgId, projectId);
  }
}
