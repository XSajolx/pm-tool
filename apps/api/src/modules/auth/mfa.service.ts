import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { mfaBackupCodes, mfaBackupSessions, organizations, users } from "../../db/schema.js";

const BACKUP_CODE_COUNT = 10;
const BACKUP_SESSION_HOURS = 12;

/**
 * Row 81: two-factor authentication. The authenticator (TOTP) factor is
 * enrolled and verified against Supabase Auth from the browser; the resulting
 * token carries `aal: "aal2"`. What we keep here is (a) whether the user has
 * a factor at all, so the guard can insist on aal2, (b) single-use backup
 * codes, and (c) which roles an admin requires 2FA for.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /** Is this session second-factor verified? Either Supabase says aal2, or a backup code was used on it. */
  async sessionState(user: { id: string; mfaEnrolledAt: Date | null }, claims: { aal?: string; session_id?: string }) {
    const enrolled = Boolean(user.mfaEnrolledAt);
    const sessionId = claims.session_id ?? null;
    if (!enrolled) return { enrolled, verified: true, sessionId };
    if (claims.aal === "aal2") return { enrolled, verified: true, sessionId };
    if (sessionId) {
      const row = await this.db.query.mfaBackupSessions.findFirst({
        where: and(eq(mfaBackupSessions.sessionId, sessionId), gt(mfaBackupSessions.expiresAt, new Date())),
      });
      if (row) return { enrolled, verified: true, sessionId };
    }
    return { enrolled, verified: false, sessionId };
  }

  async requiredRoles(orgId: string) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { mfaRequiredRoles: true } });
    return org?.mfaRequiredRoles ?? [];
  }

  async setRequiredRoles(orgId: string, roles: string[]) {
    await this.db.update(organizations).set({ mfaRequiredRoles: roles, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return { mfaRequiredRoles: roles };
  }

  /** Called after the browser verified the new TOTP factor with Supabase. Hands back fresh backup codes. */
  async markEnrolled(userId: string) {
    await this.db.update(users).set({ mfaEnrolledAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
    return this.regenerateBackupCodes(userId);
  }

  async markUnenrolled(userId: string) {
    await this.db.update(users).set({ mfaEnrolledAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
    await this.db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
    await this.db.delete(mfaBackupSessions).where(eq(mfaBackupSessions.userId, userId));
    return { enrolled: false };
  }

  async backupCodesLeft(userId: string) {
    const rows = await this.db.select({ id: mfaBackupCodes.id }).from(mfaBackupCodes).where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));
    return rows.length;
  }

  /** Ten new codes; the old set is thrown away. Plaintext is returned exactly once. */
  async regenerateBackupCodes(userId: string) {
    await this.db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => formatCode(randomBytes(5).toString("hex")));
    await this.db.insert(mfaBackupCodes).values(codes.map((c) => ({ userId, codeHash: hash(c) })));
    return { codes, left: codes.length };
  }

  /** Burn a backup code and bless this session for a while. */
  async useBackupCode(userId: string, sessionId: string | null, code: string) {
    if (!sessionId) throw new BadRequestException("This session can't be verified with a backup code");
    const row = await this.db.query.mfaBackupCodes.findFirst({
      where: and(eq(mfaBackupCodes.userId, userId), eq(mfaBackupCodes.codeHash, hash(normalise(code))), isNull(mfaBackupCodes.usedAt)),
    });
    if (!row) throw new ForbiddenException("That backup code isn't valid (or was already used)");
    await this.db.update(mfaBackupCodes).set({ usedAt: new Date() }).where(eq(mfaBackupCodes.id, row.id));
    const expiresAt = new Date(Date.now() + BACKUP_SESSION_HOURS * 3600_000);
    await this.db
      .insert(mfaBackupSessions)
      .values({ sessionId, userId, expiresAt })
      .onConflictDoUpdate({ target: mfaBackupSessions.sessionId, set: { expiresAt } });
    const left = await this.backupCodesLeft(userId);
    this.logger.log(`backup code used by ${userId}; ${left} left`);
    return { verified: true, left };
  }
}

function normalise(code: string) {
  return code.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function formatCode(hex: string) {
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}`;
}
function hash(code: string) {
  return createHash("sha256").update(normalise(code)).digest("hex");
}
