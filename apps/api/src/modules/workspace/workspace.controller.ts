import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { WorkspaceService } from "./workspace.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext, Role } from "../auth/auth.types.js";

const spaceSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
const listSchema = z.object({ name: z.string().min(1).max(255), folderId: z.string().uuid().optional() });
const folderSchema = z.object({ name: z.string().min(1).max(255) });
const bookmarkSchema = z.object({ title: z.string().min(1).max(255), url: z.string().min(3).max(2048) });
const tagSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
const statusSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  category: z.enum(["not_started", "active", "done", "closed"]).optional(),
});
const statusOrderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().max(255).optional(),
  role: z.enum(["admin", "member", "guest"]).optional(),
});
const roleSchema = z.object({ role: z.enum(["admin", "member", "guest"]) });

@Controller()
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get("spaces")
  spaces(@Auth() auth: AuthContext) {
    return this.workspace.spaceTree(auth.orgId);
  }

  @Post("spaces")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(spaceSchema))
  createSpace(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof spaceSchema>) {
    return this.workspace.createSpace(auth.orgId, dto);
  }

  @Post("spaces/:id/lists")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(listSchema))
  createList(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Body() dto: z.infer<typeof listSchema>) {
    return dto.folderId
      ? this.workspace.createListInFolder(auth.orgId, spaceId, dto.folderId, dto.name)
      : this.workspace.createList(auth.orgId, spaceId, dto.name);
  }

  /** Everything the space overview page renders, in one call. */
  @Get("spaces/:id/overview")
  overview(@Auth() auth: AuthContext, @Param("id") spaceId: string) {
    return this.workspace.spaceOverview(auth.orgId, spaceId);
  }

  @Post("spaces/:id/folders")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(folderSchema))
  createFolder(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Body() dto: z.infer<typeof folderSchema>) {
    return this.workspace.createFolder(auth.orgId, spaceId, dto.name);
  }

  @Post("spaces/:id/bookmarks")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(bookmarkSchema))
  addBookmark(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Body() dto: z.infer<typeof bookmarkSchema>) {
    return this.workspace.addBookmark(auth.orgId, auth.userId, spaceId, dto);
  }

  @Delete("spaces/:id/bookmarks/:bookmarkId")
  @Roles("owner", "admin", "member")
  removeBookmark(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Param("bookmarkId") bookmarkId: string) {
    return this.workspace.removeBookmark(auth.orgId, spaceId, bookmarkId);
  }

  @Get("spaces/:id/statuses")
  statuses(@Auth() auth: AuthContext, @Param("id") spaceId: string) {
    return this.workspace.statusesForSpace(auth.orgId, spaceId);
  }

  @Post("spaces/:id/statuses")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(statusSchema))
  createStatus(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Body() dto: z.infer<typeof statusSchema>) {
    return this.workspace.createStatus(auth.orgId, spaceId, dto);
  }

  @Put("spaces/:id/statuses/order")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(statusOrderSchema))
  reorderStatuses(@Auth() auth: AuthContext, @Param("id") spaceId: string, @Body() dto: z.infer<typeof statusOrderSchema>) {
    return this.workspace.reorderStatuses(auth.orgId, spaceId, dto.ids);
  }

  @Patch("statuses/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(statusSchema.partial()))
  updateStatus(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof statusSchema>>) {
    return this.workspace.updateStatus(auth.orgId, id, dto);
  }

  /** Tasks in the deleted status move to `reassignTo` (required when any task uses it). */
  @Delete("statuses/:id")
  @Roles("owner", "admin")
  deleteStatus(@Auth() auth: AuthContext, @Param("id") id: string, @Query("reassignTo") reassignTo?: string) {
    return this.workspace.deleteStatus(auth.orgId, id, reassignTo || undefined);
  }

  /** Tags are workspace-wide; the space-scoped paths stay as aliases for older clients. */
  @Get("tags")
  tags(@Auth() auth: AuthContext, @Query("usage") usage?: string) {
    return usage === "true" ? this.workspace.tagsWithUsage(auth.orgId) : this.workspace.tagsForOrg(auth.orgId);
  }

  @Get("spaces/:id/tags")
  tagsForSpace(@Auth() auth: AuthContext) {
    return this.workspace.tagsForOrg(auth.orgId);
  }

  @Post("tags")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(tagSchema))
  createTag(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof tagSchema>) {
    return this.workspace.createTag(auth.orgId, dto);
  }

  @Post("spaces/:id/tags")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(tagSchema))
  createTagInSpace(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof tagSchema>) {
    return this.workspace.createTag(auth.orgId, dto);
  }

  @Patch("tags/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(tagSchema.partial()))
  updateTag(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof tagSchema>>) {
    return this.workspace.updateTag(auth.orgId, id, dto);
  }

  @Post("tags/:id/merge")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(z.object({ into: z.string().uuid() })))
  mergeTag(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: { into: string }) {
    return this.workspace.mergeTag(auth.orgId, id, dto.into);
  }

  @Delete("tags/:id")
  @Roles("owner", "admin")
  retireTag(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.workspace.retireTag(auth.orgId, id);
  }

  @Get("members")
  members(@Auth() auth: AuthContext) {
    return this.workspace.members(auth.orgId);
  }

  @Post("members/invite")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(inviteSchema))
  invite(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof inviteSchema>) {
    return this.workspace.invite(auth.orgId, { ...dto, role: dto.role as Role | undefined });
  }

  @Patch("members/:userId/role")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(roleSchema))
  setRole(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body() dto: z.infer<typeof roleSchema>) {
    return this.workspace.setMemberRole(auth.orgId, userId, dto.role as Role);
  }

  @Delete("members/:userId")
  @Roles("owner", "admin")
  removeMember(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    return this.workspace.removeMember(auth.orgId, userId);
  }
}
