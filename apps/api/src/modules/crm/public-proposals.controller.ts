import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ProposalsService } from "./proposals.service.js";
import { Public } from "../auth/auth.decorators.js";

/**
 * Rows 58-59: the client side. No login — the unguessable token in the link
 * is the credential, the same trust model as a signed document link.
 */
@Controller("public/proposals")
export class PublicProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Public()
  @Get(":token")
  view(@Param("token") token: string) {
    return this.proposals.view(token);
  }

  @Public()
  @Get(":token/pdf")
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { bytes, filename } = await this.proposals.publicPdf(token);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }

  @Public()
  @Post(":token/accept")
  accept(@Param("token") token: string, @Body() body: { signerName: string; signerTitle?: string; agreed: boolean }, @Req() req: Request) {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket?.remoteAddress || undefined;
    return this.proposals.accept(token, { signerName: body?.signerName ?? "", signerTitle: body?.signerTitle, agreed: Boolean(body?.agreed) }, { ip, userAgent: req.headers["user-agent"] });
  }

  @Public()
  @Post(":token/decline")
  decline(@Param("token") token: string, @Body() body: { reason?: string }) {
    return this.proposals.decline(token, body?.reason);
  }
}
