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
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  /** Whole minutes; null clears the estimate. */
  timeEstimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
});

export const updateTaskSchema = createTaskSchema.partial().omit({ listId: true });

export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;
