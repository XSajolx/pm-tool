import { HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { signInAttempts } from "../../db/schema.js";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/**
 * Row 79: password sign-in with lockout. The browser posts e-mail + password
 * here; we check the lock, forward the credentials to Supabase Auth (the
 * identity provider) and hand the session back. Wrong passwords count against
 * the address; the fifth one locks it for a quarter of an hour. A correct
 * sign-in clears the slate.
 */
@Injectable()
export class SignInService {
  private readonly logger = new Logger(SignInService.name);
  private readonly supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  private readonly anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";

  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  get configured() {
    return Boolean(this.supabaseUrl && this.anonKey);
  }

  async signIn(rawEmail: string, password: string) {
    const email = rawEmail.trim().toLowerCase();
    const now = new Date();
    const row = await this.db.query.signInAttempts.findFirst({ where: eq(signInAttempts.email, email) });
    if (row?.lockedUntil && row.lockedUntil > now) throw this.locked(row.lockedUntil, now);

    if (!this.configured) throw new HttpException("Sign-in service is not configured (SUPABASE_URL / SUPABASE_ANON_KEY)", HttpStatus.SERVICE_UNAVAILABLE);
    const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      await this.db.delete(signInAttempts).where(eq(signInAttempts.email, email));
      const session = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
      return { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in };
    }

    // Anything but a credentials problem (e-mail not confirmed, provider down) is passed through as-is.
    const body = (await res.json().catch(() => ({}))) as { error_description?: string; msg?: string; error?: string; error_code?: string };
    const message = body.error_description ?? body.msg ?? body.error ?? "Sign-in failed";
    const badCredentials = res.status === 400 && /invalid login credentials/i.test(message);
    if (!badCredentials) throw new UnauthorizedException(message);

    const failed = (row?.failedCount ?? 0) + 1;
    if (failed >= MAX_FAILURES) {
      const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      await this.upsert(email, { failedCount: 0, lockedUntil: until, lastFailedAt: now });
      this.logger.warn(`locked ${email} for ${LOCK_MINUTES} min after ${failed} failed sign-ins`);
      throw this.locked(until, now);
    }
    await this.upsert(email, { failedCount: failed, lockedUntil: null, lastFailedAt: now });
    const left = MAX_FAILURES - failed;
    throw new UnauthorizedException(`Wrong e-mail or password. ${left} attempt${left === 1 ? "" : "s"} left before a ${LOCK_MINUTES}-minute lock.`);
  }

  /** For the sign-in form: is this address currently locked, and until when? */
  async status(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const row = await this.db.query.signInAttempts.findFirst({ where: eq(signInAttempts.email, email) });
    const locked = Boolean(row?.lockedUntil && row.lockedUntil > new Date());
    return { locked, lockedUntil: locked ? row!.lockedUntil : null };
  }

  private locked(until: Date, now: Date) {
    const mins = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
    return new HttpException(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 423 /* Locked */);
  }

  private async upsert(email: string, patch: { failedCount: number; lockedUntil: Date | null; lastFailedAt: Date }) {
    await this.db
      .insert(signInAttempts)
      .values({ email, ...patch })
      .onConflictDoUpdate({ target: signInAttempts.email, set: patch });
  }
}
