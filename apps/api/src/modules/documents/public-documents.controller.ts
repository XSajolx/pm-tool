import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { DocumentsService } from "./documents.service.js";
import { Public } from "../auth/auth.decorators.js";

/** Row 65: the client side of a shared doc. The token in the link is the credential. */
@Controller("public/docs")
export class PublicDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Public()
  @Get(":token")
  get(@Param("token") token: string) {
    return this.documents.publicByToken(token);
  }

  /** Row 67: the shared doc as a branded PDF. */
  @Public()
  @Get(":token/pdf")
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { bytes, filename } = await this.documents.publicPdf(token);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  }
}
