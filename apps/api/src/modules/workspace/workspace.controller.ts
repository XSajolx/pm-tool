import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { WorkspaceService } from "./workspace.service.js";
import { ProjectAccessService } from "../access/project-access.service.js";
import { Auth, Public, Roles } from "../auth/auth.decorators.js";
import { ActivityService } from "../activity/activity.service.js";
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
/** Row 86 */
const deactivateSchema = z.object({ endDate: z.string().datetime().nullable().optional(), reassignToUserId: z.string().uuid().nullable().optional() });
const reassignSchema = z.object({ toUserId: z.string().uuid() });

@Controller()
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly access: ProjectAccessService,
  
    private readonly activity: ActivityService,
  ) {}

  @Get("spaces")
  async spaces(@Auth() auth: AuthContext) {
    // Row 84: the sidebar only lists spaces whose project the viewer is on.
    const tree = await this.workspace.spaceTree(auth.orgId);
    const visible = await this.access.filterSpaceIds(auth.orgId, auth, tree.map((s) => s.id));
    return tree.filter((s) => visible.has(s.id));
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
  async overview(@Auth() auth: AuthContext, @Param("id") spaceId: string) {
    await this.access.assertSpace(auth.orgId, auth, spaceId);
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
  members(@Auth() auth: AuthContext, @Query("includeDeactivated") includeDeactivated?: string) {
    return this.workspace.members(auth.orgId, includeDeactivated === "true");
  }

  /* ---- Row 86: offboarding ---- */

  @Get("members/:userId/open-work")
  @Roles("owner", "admin")
  openWork(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    return this.workspace.openWork(auth.orgId, userId);
  }

  @Post("members/:userId/deactivate")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(deactivateSchema))
  async deactivate(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body() dto: z.infer<typeof deactivateSchema>) {
    const result = await this.workspace.deactivateMember(auth.orgId, auth.userId, userId, dto);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "member_deactivated", changes: dto.endDate ? [{ field: "endDate", from: null, to: dto.endDate }] : undefined });
    return result;
  }

  @Post("members/:userId/reactivate")
  @Roles("owner", "admin")
  async reactivate(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    const result = await this.workspace.reactivateMember(auth.orgId, userId);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "member_reactivated" });
    return result;
  }

  @Post("members/:userId/reassign")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(reassignSchema))
  async reassign(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body() dto: z.infer<typeof reassignSchema>) {
    return { reassigned: await this.workspace.reassignOpenTasks(auth.orgId, auth.userId, userId, dto.toUserId) };
  }

  @Post("members/invite")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(inviteSchema))
  async invite(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof inviteSchema>) {
    const result = await this.workspace.invite(auth.orgId, { ...dto, role: dto.role as Role | undefined, invitedById: auth.userId });
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "invitation", entityId: (result as { id?: string }).id ?? auth.orgId, action: "invite_sent", changes: [{ field: "email", from: null, to: dto.email }, { field: "role", from: null, to: dto.role ?? "member" }] });
    return result;
  }

  /* ---- Row 83: invitations ---- */

  @Get("invitations")
  @Roles("owner", "admin")
  invitations(@Auth() auth: AuthContext) {
    return this.workspace.listInvitations(auth.orgId);
  }

  @Post("invitations/:id/resend")
  @Roles("owner", "admin")
  async resendInvitation(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.workspace.resendInvitation(auth.orgId, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "invitation", entityId: id, action: "invite_resent" });
    return result;
  }

  @Delete("invitations/:id")
  @Roles("owner", "admin")
  async revokeInvitation(@Auth() auth: AuthContext, @Param("id") id: string) {
    const result = await this.workspace.revokeInvitation(auth.orgId, id);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "invitation", entityId: id, action: "invite_revoked" });
    return result;
  }

  /** The invite link's landing data. Public by design - the token is the secret. */
  @Public()
  @Get("public/invitations/:token")
  invitationByToken(@Param("token") token: string) {
    return this.workspace.invitationByToken(token);
  }

  @Patch("members/:userId/role")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(roleSchema))
  async setRole(@Auth() auth: AuthContext, @Param("userId") userId: string, @Body() dto: z.infer<typeof roleSchema>) {
    const result = await this.workspace.setMemberRole(auth.orgId, userId, dto.role as Role);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "role_changed", changes: [{ field: "role", from: result.previousRole, to: result.role }] });
    return result;
  }

  /** Row 82: only the owner can hand over the workspace; there is always exactly one owner. */
  @Post("members/:userId/transfer-ownership")
  @Roles("owner")
  async transferOwnership(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    const result = await this.workspace.transferOwnership(auth.orgId, auth.userId, userId);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "ownership_transferred", changes: [{ field: "owner", from: auth.userId, to: userId }] });
    return result;
  }

  @Delete("members/:userId")
  @Roles("owner", "admin")
  async removeMember(@Auth() auth: AuthContext, @Param("userId") userId: string) {
    const result = await this.workspace.removeMember(auth.orgId, userId);
    await this.activity.record({ orgId: auth.orgId, actorId: auth.userId, entityType: "member", entityId: userId, action: "member_removed" });
    return result;
  }
}
