import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UsePipes } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { ProposalsService } from "./proposals.service.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";

const sectionSchema = z.object({ key: z.string().max(40).optional().default(""), title: z.string().max(120), body: z.string().max(20_000).optional().default("") });
const writeSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  sections: z.array(sectionSchema).max(30).optional(),
  currency: z.string().length(3).optional(),
  total: z.number().nonnegative().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
});
const createSchema = z.object({ dealId: z.string().uuid(), templateId: z.string().uuid().optional(), title: z.string().max(255).optional() });
const sendSchema = z.object({
  recipients: z.array(z.object({ contactId: z.string().uuid().optional(), name: z.string().max(255).optional(), email: z.string().max(320).optional() })).min(1).max(20),
});
const templateSchema = z.object({ name: z.string().min(1).max(160), sections: z.array(sectionSchema).max(30).optional(), isDefault: z.boolean().optional() });

/** Rows 56-58: proposal templates, proposals, sending + versions. */
@Controller("crm")
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get("proposal-templates")
  templates(@Auth() auth: AuthContext) {
    return this.proposals.templates(auth.orgId);
  }

  @Post("proposal-templates")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema))
  createTemplate(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof templateSchema>) {
    return this.proposals.createTemplate(auth.orgId, dto);
  }

  @Patch("proposal-templates/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema.partial()))
  updateTemplate(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof templateSchema>>) {
    return this.proposals.updateTemplate(auth.orgId, id, dto);
  }

  @Delete("proposal-templates/:id")
  @Roles("owner", "admin")
  removeTemplate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.proposals.removeTemplate(auth.orgId, id);
  }

  @Get("proposals")
  list(@Auth() auth: AuthContext, @Query("dealId") dealId?: string, @Query("companyId") companyId?: string) {
    return this.proposals.list(auth.orgId, { dealId: dealId || undefined, companyId: companyId || undefined });
  }

  @Post("proposals")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.proposals.createFromDeal(auth.orgId, auth.userId, dto);
  }

  @Get("proposals/:id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.proposals.get(auth.orgId, id);
  }

  @Patch("proposals/:id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(writeSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof writeSchema>) {
    return this.proposals.update(auth.orgId, auth.userId, id, dto);
  }

  @Post("proposals/:id/send")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(sendSchema))
  send(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof sendSchema>) {
    return this.proposals.send(auth.orgId, auth.userId, id, dto.recipients);
  }

  @Get("proposals/:id/versions/:version/pdf")
  async pdf(@Auth() auth: AuthContext, @Param("id") id: string, @Param("version") version: string, @Res() res: Response) {
    const { bytes, filename } = await this.proposals.versionPdf(auth.orgId, id, Number(version));
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  @Delete("proposals/:id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.proposals.archive(auth.orgId, id);
  }
}
