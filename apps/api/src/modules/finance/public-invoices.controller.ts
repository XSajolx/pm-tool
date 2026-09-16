import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/auth.decorators.js";
import { InvoicesService } from "./invoices.service.js";

/**
 * Row 156: what the client opens. No login — the unguessable token in the
 * link is the credential, same trust model as the proposal links.
 */
@Controller("public/invoices")
export class PublicInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Public()
  @Get(":token")
  view(@Param("token") token: string) {
    return this.invoices.view(token);
  }

  @Public()
  @Get(":token/pdf")
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { bytes, filename } = await this.invoices.publicPdf(token);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }
}
