import { Body, Controller, Get, Param, Post, Req, Res, UsePipes } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Public } from "../auth/auth.decorators.js";
import { clientMeta, signSchema } from "./contracts.controller.js";
import { ContractsService } from "./contracts.service.js";

/**
 * Row 158: the client side. No login — the unguessable token in the link is
 * the credential; every open and signature is written to the audit trail.
 */
@Controller("public/contracts")
export class PublicContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Public()
  @Get(":token")
  view(@Param("token") token: string, @Req() req: Request) {
    return this.contracts.view(token, clientMeta(req));
  }

  @Public()
  @Get(":token/pdf")
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { bytes, filename } = await this.contracts.publicPdf(token);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  @Public()
  @Post(":token/sign")
  @UsePipes(new ZodValidationPipe(signSchema))
  sign(@Param("token") token: string, @Body() body: z.infer<typeof signSchema>, @Req() req: Request) {
    return this.contracts.sign(token, body, clientMeta(req));
  }

  @Public()
  @Post(":token/decline")
  decline(@Param("token") token: string, @Body() body: { reason?: string }, @Req() req: Request) {
    return this.contracts.decline(token, body?.reason, clientMeta(req));
  }
}
