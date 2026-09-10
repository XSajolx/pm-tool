import { z } from "zod";

export const createTaskSchema = z.object({
  listId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  statusId: z.string().uuid().optional(),
  priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
  parentTaskId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
});

export const updateTaskSchema = createTaskSchema.partial().omit({ listId: true });

export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;
