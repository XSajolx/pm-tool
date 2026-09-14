import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ActivityService } from "../activity/activity.service.js";
import { ExportService } from "./export.service.js";

/** Row 117: download the workspace (or one project) as ZIP of JSON + CSVs. Owners/admins only. */
@Controller("export")
export class ExportController {
  constructor(
    private readonly exporter: ExportService,
    private readonly activity: ActivityService,
  ) {}

  @Get("workspace")
  @Roles("owner", "admin")
  async workspace(@Auth() auth: AuthContext, @Res() res: Response) {
    const out = await this.exporter.build(auth.orgId);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "workspace", entityId: auth.orgId, action: "export_created", changes: [{ field: "scope", from: null, to: "workspace" }, { field: "counts", from: null, to: out.counts }] });
    this.send(res, out);
  }

  @Get("projects/:id")
  @Roles("owner", "admin")
  async project(@Auth() auth: AuthContext, @Param("id") id: string, @Res() res: Response) {
    const out = await this.exporter.build(auth.orgId, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "project", entityId: id, action: "export_created", changes: [{ field: "counts", from: null, to: out.counts }] });
    this.send(res, out);
  }

  private send(res: Response, out: { filename: string; bytes: Buffer }) {
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${out.filename}"`);
    res.setHeader("content-length", String(out.bytes.length));
    res.end(out.bytes);
  }
}
