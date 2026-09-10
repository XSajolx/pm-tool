import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Verifies Supabase Auth access tokens.
 *
 * This project signs with an asymmetric key (ES256) and publishes the public half
 * at /auth/v1/.well-known/jwks.json, so verification is a local cryptographic
 * check — no network round-trip per request, and no shared secret in our env.
 * `createRemoteJWKSet` fetches the key set once and re-fetches only when a token
 * arrives with an unknown `kid` (i.e. after a key rotation), with cooldown.
 *
 * Note this is deliberately independent of the DATABASE_URL: the Supabase REST
 * host is dual-stack and reachable, while the Postgres host is IPv6-only — app
 * data lives on our own Postgres and only identity comes from Supabase.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    const url = process.env.SUPABASE_URL;
    if (!url) {
      throw new Error(
        "SUPABASE_URL is not set — copy .env.example to .env and fill it in.",
      );
    }
    this.issuer = `${url.replace(/\/$/, "")}/auth/v1`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
      { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
    );
  }

  /** Returns the verified claims, or throws 401. Never trusts an unverified token. */
  async verify(token: string): Promise<JWTPayload & { sub: string; email?: string }> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        // Supabase mints access tokens for the "authenticated" audience.
        audience: "authenticated",
      });
      if (!payload.sub) throw new Error("token has no sub claim");
      return payload as JWTPayload & { sub: string; email?: string };
    } catch (err) {
      // Log the reason server-side; tell the client nothing beyond "unauthorized".
      this.logger.debug(`token rejected: ${(err as Error).message}`);
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
