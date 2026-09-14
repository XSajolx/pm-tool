import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CustomFieldsService, FIELD_ENTITIES, FIELD_TYPES, type FieldEntity } from "./custom-fields.service.js";

const entity = z.enum(["task", "project", "contact"]);
const createSchema = z.object({ entityType: entity, name: z.string().trim().min(1).max(80), type: z.enum(["text", "number", "date", "select", "checkbox", "url", "user"]), options: z.array(z.string().max(80)).max(50).optional(), required: z.boolean().optional() });
const patchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), options: z.array(z.string().max(80)).max(50).optional(), required: z.boolean().optional(), position: z.number().optional() });
const reorderSchema = z.object({ entityType: entity, ids: z.array(z.string().uuid()).min(1) });
const valuesSchema = z.object({ values: z.record(z.string().uuid(), z.unknown()) });

/** Row 114: custom field definitions (admins) and values (anyone who can edit the record). */
@Controller("custom-fields")
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query("entityType") entityType?: string) {
    return this.fields.listDefs(auth.orgId, FIELD_ENTITIES.includes(entityType as FieldEntity) ? (entityType as FieldEntity) : undefined);
  }

  @Get("types")
  types() {
    return { entities: FIELD_ENTITIES, types: FIELD_TYPES };
  }

  @Post()
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.fields.createDef(auth.orgId, dto);
  }

  @Post("reorder")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reorderSchema))
  reorder(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof reorderSchema>) {
    return this.fields.reorder(auth.orgId, dto.entityType, dto.ids);
  }

  @Patch(":id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(patchSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof patchSchema>) {
    return this.fields.updateDef(auth.orgId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.fields.archiveDef(auth.orgId, id);
  }

  @Get("values/:entityType/:entityId")
  values(@Auth() auth: AuthContext, @Param("entityType") entityType: string, @Param("entityId") entityId: string) {
    return this.fields.valuesFor(auth.orgId, entity.parse(entityType), entityId);
  }

  @Put("values/:entityType/:entityId")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(valuesSchema))
  setValues(@Auth() auth: AuthContext, @Param("entityType") entityType: string, @Param("entityId") entityId: string, @Body() dto: z.infer<typeof valuesSchema>) {
    return this.fields.setValues(auth.orgId, auth.userId, entity.parse(entityType), entityId, dto.values);
  }
}
