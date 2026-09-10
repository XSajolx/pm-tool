import { Body, Controller, Delete, Get, Param, Post, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CyclesService } from "./cycles.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const createSchema = z.object({
  spaceId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const addTaskSchema = z.object({ taskId: z.string().uuid() });

@Controller("cycles")
export class CyclesController {
  constructor(private readonly cycles: CyclesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("spaceId") spaceId: string) {
    return this.cycles.listForSpace(auth.orgId, spaceId);
  }

  @Post()
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.cycles.create(auth.orgId, auth.userId, dto);
  }

  @Get(":id/tasks")
  tasks(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.cycles.tasksIn(auth.orgId, id);
  }

  @Post(":id/tasks")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(addTaskSchema))
  addTask(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() dto: z.infer<typeof addTaskSchema>,
  ) {
    return this.cycles.addTask(auth.orgId, auth.userId, id, dto.taskId);
  }

  @Delete("tasks/:taskId")
  @Roles("owner", "admin", "member")
  removeTask(@Auth() auth: AuthContext, @Param("taskId") taskId: string) {
    return this.cycles.removeTask(auth.orgId, auth.userId, taskId);
  }
}
