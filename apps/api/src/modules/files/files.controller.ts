import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { FilesService, type UploadedFileLike } from "./files.service.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { Auth, Public, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const MAX_BYTES = 25 * 1024 * 1024;

@Controller("files")
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly access: ProjectAccessService,
  ) {}

  /** Multipart upload: field "file" plus channelId or taskId (row 43). */
  @Post()
  @Roles("owner", "admin", "member")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  upload(@Auth() auth: AuthContext, @UploadedFile() file: UploadedFileLike | undefined, @Body() body: { channelId?: string; taskId?: string }) {
    if (!file) throw new BadRequestException("No file in the request");
    return this.files.upload(auth.orgId, auth.userId, file, body);
  }

  @Get()
  async list(@Auth() auth: AuthContext, @Query("channelId") channelId?: string, @Query("taskId") taskId?: string) {
    if (taskId) {
      // Row 2: task attachments follow task visibility (row 84).
      await this.access.assertTask(auth.orgId, auth, taskId);
      return this.files.listForTask(auth.orgId, taskId);
    }
    if (!channelId) throw new BadRequestException("channelId or taskId is required");
    return this.files.listForChannel(auth.orgId, channelId, auth.userId);
  }

  /**
   * Bytes for local storage. Public by unguessable id — the same trust model
   * as a signed S3 URL — so <img src> and download links work without headers.
   */
  @Public()
  @Get(":id/raw")
  async raw(@Param("id") id: string, @Res() res: Response) {
    const { row, stream } = await this.files.raw(id);
    if (!stream) throw new NotFoundException("File bytes are not on this server");
    res.setHeader("content-type", row.mimeType);
    res.setHeader("content-length", String(row.sizeBytes));
    res.setHeader("content-disposition", `inline; filename="${encodeURIComponent(row.filename)}"`);
    res.setHeader("cache-control", "private, max-age=3600");
    stream.pipe(res);
  }

  @Delete(":id")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.files.remove(auth.orgId, auth.userId, auth.role, id);
  }
}
