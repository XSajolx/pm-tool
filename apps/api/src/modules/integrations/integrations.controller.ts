import { Controller, Delete, Get, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Auth, Public, Roles } from "../auth/auth.decorators.js";
import type { AuthContext } from "../auth/auth.types.js";
import { IntegrationsService, PROVIDERS, type Provider } from "./integrations.service.js";

function asProvider(p: string): Provider {
  if (!PROVIDERS.includes(p as Provider)) throw new Error("Unknown provider");
  return p as Provider;
}

/** Row 112 (+116): connect Drive / Dropbox once per workspace; health checks. */
@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.integrations.list(auth.orgId);
  }

  /** Returns the consent URL; the web app navigates there. */
  @Post(":provider/start")
  @Roles("owner", "admin")
  start(@Auth() auth: AuthContext, @Param("provider") provider: string) {
    return this.integrations.start(auth.orgId, auth.userId, asProvider(provider));
  }

  /** The provider redirects the browser here - no bearer token, so the state nonce carries org + user. */
  @Public()
  @Get(":provider/callback")
  async callback(@Param("provider") provider: string, @Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error") error: string | undefined, @Res() res: Response) {
    const to = await this.integrations.callback(asProvider(provider), code, state, error);
    res.redirect(302, to);
  }

  @Post(":provider/check")
  @Roles("owner", "admin")
  check(@Auth() auth: AuthContext, @Param("provider") provider: string) {
    return this.integrations.check(auth.orgId, asProvider(provider));
  }

  @Delete(":provider")
  @Roles("owner", "admin")
  disconnect(@Auth() auth: AuthContext, @Param("provider") provider: string) {
    return this.integrations.disconnect(auth.orgId, asProvider(provider));
  }
}
