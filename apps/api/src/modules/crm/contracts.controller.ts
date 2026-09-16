import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UsePipes } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { ContractsService } from "./contracts.service.js";

const sectionSchema = z.object({ key: z.string().max(40), title: z.string().max(120), body: z.string().max(30_000) });
const kindSchema = z.enum(["service_agreement", "nda", "retainer", "contractor", "custom"]);
const fieldsSchema = z.object({
  fee: z.number().nullable().optional(),
  currency: z.string().length(3).optional(),
  startDate: z.string().max(10).nullable().optional(),
  endDate: z.string().max(10).nullable().optional(),
  custom: z.record(z.string().max(40), z.string().max(500)).optional(),
});
const signerSchema = z.object({ id: z.string().uuid().optional(), contactId: z.string().uuid().nullable().optional(), name: z.string().max(255).optional(), email: z.string().max(320).nullable().optional() });

const writeSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  kind: kindSchema.optional(),
  sections: z.array(sectionSchema).max(40).optional(),
  fields: fieldsSchema.optional(),
  validUntil: z.string().datetime().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  requireCountersign: z.boolean().optional(),
  signers: z.array(signerSchema).max(10).optional(),
});
const createSchema = writeSchema.extend({ templateId: z.string().uuid().nullable().optional() });

const templateSchema = z.object({
  name: z.string().min(1).max(160),
  kind: kindSchema.optional(),
  description: z.string().max(255).nullable().optional(),
  sections: z.array(sectionSchema).max(40).optional(),
  isDefault: z.boolean().optional(),
});

export const signSchema = z.object({
  signatureType: z.enum(["typed", "drawn"]),
  name: z.string().min(1).max(255),
  title: z.string().max(255).optional(),
  image: z.string().max(300_000).nullable().optional(),
  agreed: z.boolean(),
});

const saveTemplateSchema = z.object({ name: z.string().min(1).max(160), kind: kindSchema.optional(), isDefault: z.boolean().optional() });
const signerUserSchema = z.object({ userId: z.string().uuid() });

export function clientMeta(req: Request) {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket?.remoteAddress || undefined;
  return { ip, userAgent: req.headers["user-agent"] };
}

/** Rows 158-159: contract templates, contracts, sending, countersigning, PDF. */
@Controller("crm")
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get("contract-templates")
  templates(@Auth() auth: AuthContext) {
    return this.contracts.templates(auth.orgId);
  }

  @Post("contract-templates")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema))
  createTemplate(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof templateSchema>) {
    return this.contracts.createTemplate(auth.orgId, dto);
  }

  @Patch("contract-templates/:id")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(templateSchema.partial()))
  updateTemplate(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: Partial<z.infer<typeof templateSchema>>) {
    return this.contracts.updateTemplate(auth.orgId, id, dto);
  }

  @Delete("contract-templates/:id")
  @Roles("owner", "admin")
  removeTemplate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contracts.removeTemplate(auth.orgId, id);
  }

  @Get("contracts")
  list(@Auth() auth: AuthContext, @Query("companyId") companyId?: string, @Query("dealId") dealId?: string, @Query("projectId") projectId?: string, @Query("status") status?: string) {
    return this.contracts.list(auth.orgId, { companyId, dealId, projectId, status });
  }

  @Post("contracts")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(createSchema))
  create(@Auth() auth: AuthContext, @Body() dto: z.infer<typeof createSchema>) {
    return this.contracts.create(auth.orgId, auth.userId, dto);
  }

  @Get("contracts/:id")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contracts.get(auth.orgId, id);
  }

  @Get("contracts/:id/pdf")
  async pdf(@Auth() auth: AuthContext, @Param("id") id: string, @Res() res: Response) {
    const { bytes, filename } = await this.contracts.pdf(auth.orgId, id);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  @Patch("contracts/:id")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(writeSchema))
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof writeSchema>) {
    return this.contracts.update(auth.orgId, auth.userId, id, dto);
  }

  @Patch("contracts/:id/company-signer")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(signerUserSchema))
  companySigner(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof signerUserSchema>) {
    return this.contracts.setCompanySigner(auth.orgId, auth.userId, id, dto.userId);
  }

  @Post("contracts/:id/send")
  @Roles("owner", "admin")
  send(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contracts.send(auth.orgId, auth.userId, id);
  }

  @Post("contracts/:id/reopen")
  @Roles("owner", "admin")
  reopen(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contracts.reopen(auth.orgId, auth.userId, id);
  }

  @Post("contracts/:id/countersign")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(signSchema))
  countersign(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof signSchema>, @Req() req: Request) {
    return this.contracts.countersign(auth.orgId, auth.userId, id, dto, clientMeta(req));
  }

  @Post("contracts/:id/save-template")
  @Roles("owner", "admin")
  @UsePipes(new ZodValidationPipe(saveTemplateSchema))
  saveTemplate(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof saveTemplateSchema>) {
    return this.contracts.saveAsTemplate(auth.orgId, id, dto);
  }

  @Delete("contracts/:id")
  @Roles("owner", "admin")
  archive(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.contracts.archive(auth.orgId, auth.userId, id);
  }
}
