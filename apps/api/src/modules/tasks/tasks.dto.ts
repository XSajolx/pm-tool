import { z } from "zod";

// Dates arrive as ISO strings; `null` clears a date on update.
const isoDate = z.string().datetime();

export const createTaskSchema = z.object({
  listId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  statusId: z.string().uuid().optional(),
  priority: z.enum(["urgent", "high", "normal", "low"]).nullable().optional(),
  parentTaskId: z.string().uuid().optional(),
  /** Project stage; null clears. Must belong to the project that owns the task's space. */
  stageId: z.string().uuid().nullable().optional(),
  /** Milestone this task counts toward; null clears. Same project rule as stages. */
  milestoneId: z.string().uuid().nullable().optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  /** Row 47: chat message this task came from (create only). */
  sourceMessageId: z.string().uuid().optional(),
  /** CRM links (row 38); null clears. A deal fills in its company/contact when those are left out. */
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  recurrence: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
  recurrenceInterval: z.number().int().min(1).max(365).optional(),
  /** Whole minutes; null clears the estimate. */
  /** Row 119 */
  clientVisible: z.boolean().optional(),
  timeEstimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
});

export const updateTaskSchema = createTaskSchema.partial().omit({ listId: true });

export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

/** PATCH /tasks/bulk — the same patch applied to many tasks, plus tag add/remove and move-to-list. */
export const bulkUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  patch: updateTaskSchema
    .pick({ statusId: true, priority: true, dueDate: true, startDate: true, assigneeIds: true, stageId: true, milestoneId: true })
    .extend({
      addTagIds: z.array(z.string().uuid()).optional(),
      removeTagIds: z.array(z.string().uuid()).optional(),
      /** Move to another list (possibly another project/space). */
      listId: z.string().uuid().optional(),
    }),
});
export type BulkUpdateDto = z.infer<typeof bulkUpdateSchema>;
