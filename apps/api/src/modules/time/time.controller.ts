import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { TimeService } from "./time.service.js";
import { TimeCodesService } from "./time-codes.service.js";
import { TimesheetRemindersService, type ReminderSlot } from "./timesheet-reminders.service.js";
import { LeaveService, type LeaveKind } from "./leave.service.js";
import { WorkCalendarService } from "./work-calendar.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
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
/** Row 110 */
const calendarSchema = z.object({ standardWeeklyHours: z.number().int().min(0).max(168).optional(), workingDays: z.array(z.number().int().min(0).max(6)).optional() });
const holidaySchema = z.object({ date: z.string().min(8), name: z.string().trim().min(1).max(120), kind: z.enum(["holiday", "closure"]).optional() });
const memberCalendarSchema = z.object({
  weeklyCapacityHours: z.number().int().min(0).max(168).optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  employmentType: z.enum(["full_time", "part_time", "contractor"]).optional(),
});
/** Row 98 */
const leaveSchema = z.object({
  kind: z.enum(["vacation", "sick", "personal", "other"]),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  note: z.string().max(2000).optional(),
  hoursPerDay: z.number().min(0.5).max(24).optional(),
});
/** Row 97 */
const nudgeSchema = z.object({ userId: z.string().uuid(), week: z.string().min(8) });
/** Row 93 */
const reopenSchema = z.object({ reason: z.string().min(1).max(2000) });
/** Row 94 */
const reminderSlotSchema = z.object({ weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), week: z.enum(["current", "previous"]) });
const reminderScheduleSchema = z.object({ slots: z.array(reminderSlotSchema).max(7) });

@Controller("time")
export class TimeController {
  constructor(
    private readonly time: TimeService,
    private readonly codes: TimeCodesService,
    private readonly reminders: TimesheetRemindersService,
    private readonly leave: LeaveService,
    private readonly calendar: WorkCalendarService,
  
    private readonly activity: ActivityService,
  ) {}

  /* ---- Row 98: time off ---- */

  @Get("leave")
  listLeave(@Auth() auth: AuthContext, @Query("from") from?: string, @Query("to") to?: string, @Query("all") all?: string) {
    return this.leave.list(auth.orgId, this.actor(auth), { from, to, all: all === "true" });
  }

  @Get("leave/calendar")
  leaveCalendar(@Auth() auth: AuthContext, @Query("from") from: string, @Query("to") to: string) {
    return this.leave.calendar(auth.orgId, from, to);
  }

  @Post("leave")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(leaveSchema))
  requestLeave(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof leaveSchema>) {
    return this.leave.create(auth.orgId, this.actor(auth), { ...dto, kind: dto.kind as LeaveKind });
  }

  @Post("leave/:id/decision")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(decisionSchema))
  decideLeave(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.leave.decide(auth.orgId, this.actor(auth), id, dto.approve, dto.note);
  }

  @Delete("leave/:id")
  @Roles(...WRITERS)
  cancelLeave(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.leave.cancel(auth.orgId, this.actor(auth), id);
  }

  /* ---- Row 94: missing-timesheet reminders ---- */

  @Get("timesheet/reminders")
  reminderSchedule(@Auth() auth: AuthContext) {
    return this.reminders.schedule(auth.orgId);
  }

  @Put("timesheet/reminders")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reminderScheduleSchema))
  setReminderSchedule(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof reminderScheduleSchema>) {
    return this.reminders.setSchedule(auth.orgId, dto.slots as ReminderSlot[]);
  }

  /** Who would be nudged by a slot right now (admins). */
  @Get("timesheet/reminders/preview")
  reminderPreview(@Auth() auth: AuthContext, @Query("week") week?: string) {
    return this.reminders.incomplete(auth.orgId, { weekday: 0, hour: 0, week: week === "previous" ? "previous" : "current" });
  }

  /** Send a slot now, ignoring the clock (admins) - for testing the wording. */
  @Post("timesheet/reminders/send")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reminderSlotSchema))
  sendReminderNow(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof reminderSlotSchema>) {
    return this.reminders.sweep({ orgId: auth.orgId, slot: dto as ReminderSlot });
  }

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

  /* ---------------- Row 110: working hours & holidays ---------------- */
  @Get("calendar")
  calendar_(@Auth() auth: AuthContext) {
    return this.calendar.settings(auth.orgId);
  }

  @Patch("calendar")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(calendarSchema))
  async updateCalendar(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof calendarSchema>) {
    const result = await this.calendar.updateSettings(auth.orgId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "work_calendar_updated", changes: Object.entries(dto).map(([k, v]) => ({ field: k, from: null, to: v })) });
    return result;
  }

  @Post("calendar/holidays")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(holidaySchema))
  async addHoliday(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof holidaySchema>) {
    const result = await this.calendar.addHoliday(auth.orgId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "holiday_added", changes: [{ field: "holiday", from: null, to: `${dto.date.slice(0, 10)} ${dto.name}` }] });
    return result;
  }

  @Delete("calendar/holidays/:id")
  @Roles("owner", "admin")
  async removeHoliday(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.calendar.removeHoliday(auth.orgId, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "holiday_removed", changes: [{ field: "holidayId", from: id, to: null }] });
    return result;
  }

  @Patch("calendar/members/:userId")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(memberCalendarSchema))
  async updateMemberCalendar(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body() dto: z.infer<typeof memberCalendarSchema>) {
    const result = await this.calendar.updateMember(auth.orgId, userId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "working_hours_updated", changes: Object.entries(dto).map(([k, v]) => ({ field: k, from: null, to: v })) });
    return result;
  }

  /** Row 104: what's waiting on me. */
  @Get("timesheet/pending")
  pending(@Auth() auth: AuthContext) {
    return this.time.pendingSubmissions(auth.orgId, this.actor(auth));
  }

  @Post("timesheet/submissions/:id/decision")
  @Roles(...WRITERS)
  @UsePipes(new ZodValidationPipe(decisionSchema))
  decideSubmission(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof decisionSchema>) {
    return this.time.decideTimesheet(auth.orgId, this.actor(auth), id, dto.approve, dto.note);
  }

  /** Row 103: hours this week per person, project vs internal vs leave, against expected. Members see only themselves. */
  @Get("workload")
  workload(@Auth() auth: AuthContext, @Query("week") week?: string) {
    const manager = auth.role === "owner" || auth.role === "admin";
    return this.time.workload(auth.orgId, week ?? new Date().toISOString(), manager ? undefined : auth.userId);
  }

  /** Row 97: week-by-person status board (project managers). */
  @Get("timesheet/board")
  @Roles("owner", "admin")
  board(@Auth() auth: AuthContext, @Query("week") week?: string) {
    return this.time.teamBoard(auth.orgId, week ?? new Date().toISOString());
  }

  @Post("timesheet/board/nudge")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(nudgeSchema))
  nudge(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof nudgeSchema>) {
    return this.time.nudge(auth.orgId, this.actor(auth), dto.userId, dto.week);
  }

  /** Row 93: unlock an approved week with a reason (admins / the approver). */
  @Post("timesheet/submissions/:id/reopen")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reopenSchema))
  reopenSubmission(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof reopenSchema>) {
    return this.time.reopenTimesheet(auth.orgId, this.actor(auth), id, dto.reason);
  }

  @Get("timesheet/submissions/:id/events")
  submissionEvents(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.time.timesheetEvents(auth.orgId, this.actor(auth), id);
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
