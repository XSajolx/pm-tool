import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
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
  constructor(private readonly fields: CustomFieldsService, private readonly activity: ActivityService) {}

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
  async create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    const result = await this.fields.createDef(auth.orgId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "custom_field", entityId: result.id, action: "field_created", changes: [{ field: "name", from: null, to: `${dto.name} (${dto.type} on ${dto.entityType})` }] });
    return result;
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
  async archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.fields.archiveDef(auth.orgId, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "custom_field", entityId: id, action: "field_archived" });
    return result;
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
