import { Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { TrashService, type TrashType } from "./trash.service.js";

const TYPES: TrashType[] = ["task", "document", "project"];
function asType(t: string): TrashType {
  if (!TYPES.includes(t as TrashType)) throw new Error("Unknown type");
  return t as TrashType;
}

/** Row 125: the Trash - restore within 30 days, or delete for good. */
@Controller("trash")
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  @Get()
  @Roles("owner", "admin", "member")
  list(@Auth() auth: AuthContext) {
    return this.trash.list(auth.orgId);
  }

  @Post(":type/:id/restore")
  @Roles("owner", "admin", "member")
  restore(@Auth() auth: AuthContext, @Param("type") type: string, @Param("id") id: string) {
    return this.trash.restore(auth.orgId, auth.userId, asType(type), id);
  }

  @Delete(":type/:id")
  @Roles("owner", "admin")
  destroy(@Auth() auth: AuthContext, @Param("type") type: string, @Param("id") id: string) {
    return this.trash.destroy(auth.orgId, auth.userId, asType(type), id);
  }
}
