import { Body, Controller, Delete, Get, Param, Patch, Post, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { NotesService, type NoteEntity } from "./notes.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const entitySchema = z.enum(["company", "contact", "deal"]);
const bodySchema = z.object({
  body: z.string().min(1).max(20_000),
  kind: z.enum(["note", "call", "meeting", "email"]).optional(),
  occurredAt: z.string().datetime().nullable().optional(),
});

@Controller("crm/notes")
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get(":entityType/:entityId")
  list(@Auth() auth: AuthContext, @Param("entityType") entityType: string, @Param("entityId") entityId: string) {
    return this.notes.list(auth.orgId, entitySchema.parse(entityType) as NoteEntity, entityId);
  }

  @Post(":entityType/:entityId")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(bodySchema))
  create(
    @Auth() auth: AuthContext,
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body() dto: z.infer<typeof bodySchema>,
  ) {
    return this.notes.create(auth.orgId, auth.userId, entitySchema.parse(entityType) as NoteEntity, entityId, dto);
  }

  @Patch(":id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(bodySchema.partial()))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof bodySchema>>) {
    return this.notes.update(auth.orgId, { userId: auth.userId, role: auth.role }, id, dto);
  }

  @Patch(":id/pin")
  @Roles("owner", "admin", "member")
  pin(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notes.togglePin(auth.orgId, id);
  }

  @Delete(":id")
  @Roles("owner", "admin", "member")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.notes.remove(auth.orgId, { userId: auth.userId, role: auth.role }, id);
  }
}
