import { Body, Controller, Get, Headers, Param, Post, Query, UnauthorizedException, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { Auth, Public, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { InboundEmailService } from "./inbound-email.service.js";

const testSchema = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().min(1).max(500),
  text: z.string().max(20_000).optional(),
  attachments: z.array(z.object({ name: z.string().max(200), contentType: z.string().max(120), contentBase64: z.string().max(2_000_000) })).max(5).optional(),
});

@Controller()
export class InboundEmailController {
  constructor(private readonly inbound: InboundEmailService) {}

  /**
   * Row 78: the provider webhook. Postmark posts its inbound JSON here; the
   * shared secret (INBOUND_EMAIL_SECRET) travels as a header or `?secret=`.
   * Always answers 200 with a reason so the provider doesn't retry forever.
   */
  @Public()
  @Post("public/inbound/email")
  async webhook(@Body() raw: Record<string, unknown>, @Headers("x-inbound-secret") header?: string, @Query("secret") query?: string) {
    const expected = process.env.INBOUND_EMAIL_SECRET;
    if (expected && header !== expected && query !== expected) throw new UnauthorizedException("Bad inbound secret");
    try {
      return { ok: true, ...(await this.inbound.handle(this.inbound.normalise(raw))) };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  @Get("projects/:id/inbound-email")
  address(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.inbound.addressFor(auth.orgId, id);
  }

  @Post("projects/:id/inbound-email/regenerate")
  @Roles("owner", "admin")
  regenerate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.inbound.regenerate(auth.orgId, id);
  }

  /** Simulate a forwarded mail to this project - handy before the provider is wired up. */
  @Post("projects/:id/inbound-email/test")
  @Roles("owner", "admin", "member")
  @UsePipes(new ZodValidationPipe(testSchema))
  async test(@Auth() auth: AuthContext, @Param("id") id: string, @Body() dto: z.infer<typeof testSchema>) {
    const { address } = await this.inbound.addressFor(auth.orgId, id);
    return this.inbound.handle({ from: dto.from, to: [address], subject: dto.subject, text: dto.text ?? null, attachments: dto.attachments ?? [] });
  }
}
