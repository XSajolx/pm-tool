import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors, UsePipes } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ImportService } from "./import.service.js";

const runSchema = z.object({
  importId: z.string().min(8),
  mapping: z.record(
    z.string(),
    z.object({
      listId: z.string().uuid().optional(),
      createIn: z.object({ spaceId: z.string().uuid().optional(), newSpaceName: z.string().max(120).optional(), listName: z.string().min(1).max(255) }).optional(),
      statuses: z.record(z.string(), z.string()).optional(),
    }),
  ),
  assignees: z.record(z.string(), z.string().uuid().nullable()).optional(),
});

/** Row 126: upload a ClickUp CSV export, map it, import it. Owners/admins. */
@Controller("import/clickup")
export class ImportController {
  constructor(private readonly importer: ImportService) {}

  @Post("preview")
  @Roles("owner", "admin")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  preview(@Auth() auth: AuthContext, @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined) {
    if (!file) throw new BadRequestException("Choose a CSV file first");
    return this.importer.preview(auth.orgId, file);
  }

  @Post("run")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(runSchema))
  run(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof runSchema>) {
    return this.importer.run(auth.orgId, auth.userId, dto.importId, dto.mapping, dto.assignees ?? {});
  }
}
