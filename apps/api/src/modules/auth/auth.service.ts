import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { JWTPayload } from "jose";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { memberships, organizations, users } from "../../db/schema.js";
import type { AuthContext, Role } from "./auth.types.js";

/** Shape of the Supabase claims we actually read. */
type Claims = JWTPayload & {
  sub: string;
  email?: string;
  user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * Maps a verified Supabase identity onto our own `users` row, creating it on
   * first sight ("just-in-time provisioning").
   *
   * The email-claim step matters for continuity: seeded rows were written with a
   * placeholder subject (`seed|demo-user`). The first time the real Supabase
   * account with that same email signs in, we attach the real `sub` to the
   * existing row rather than creating a duplicate — so the demo user keeps their
   * seeded tasks, assignments and chat history.
   */
  async resolveUser(claims: Claims) {
    const bySubject = await this.db.query.users.findFirst({
      where: eq(users.authSubject, claims.sub),
    });
    if (bySubject) return bySubject;

    const email = claims.email?.toLowerCase();
    if (!email) {
      throw new ConflictException("Supabase account has no email address");
    }

    const meta = claims.user_metadata ?? {};
    const name = meta.name ?? meta.full_name ?? email.split("@")[0]!;

    const byEmail = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (byEmail) {
      const [claimed] = await this.db
        .update(users)
        .set({ authSubject: claims.sub, updatedAt: new Date() })
        .where(eq(users.id, byEmail.id))
        .returning();
      this.logger.log(`linked existing user ${email} to subject ${claims.sub}`);
      return claimed!;
    }

    const [created] = await this.db
      .insert(users)
      .values({
        authSubject: claims.sub,
        email,
        name,
        avatarUrl: meta.avatar_url ?? null,
      })
      .returning();
    this.logger.log(`provisioned new user ${email}`);
    return created!;
  }

  /** Orgs the user belongs to, with their role in each. Drives the org switcher. */
  async membershipsFor(userId: string) {
    const rows = await this.db.query.memberships.findMany({
      where: eq(memberships.userId, userId),
      with: { organization: true },
    });
    return rows.map((m) => ({
      organizationId: m.organizationId,
      role: m.role,
      organization: {
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
      },
    }));
  }

  /* ---------------- Row 80: Google Workspace SSO ---------------- */

  /**
   * A Google-verified sign-in whose e-mail domain matches a workspace's
   * `ssoDomain` joins that workspace as a member automatically - so the Google
   * admin adding someone to the company domain is all the onboarding needed.
   * Password sign-ups never auto-join: anyone can type any address.
   */
  async autoJoinBySsoDomain(userId: string, email: string, provider?: string) {
    if (provider !== "google") return [];
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return [];
    const orgs = await this.db.query.organizations.findMany({ where: eq(organizations.ssoDomain, domain), columns: { id: true, name: true } });
    const joined: string[] = [];
    for (const org of orgs) {
      const existing = await this.membershipIn(userId, org.id);
      if (existing) continue;
      await this.db.insert(memberships).values({ organizationId: org.id, userId, role: "member" satisfies Role }).onConflictDoNothing();
      joined.push(org.name);
      this.logger.log(`SSO auto-join: ${email} -> ${org.name}`);
    }
    return joined;
  }

  async getSso(orgId: string) {
    const org = await this.db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { ssoDomain: true } });
    return { ssoDomain: org?.ssoDomain ?? null, googleProviderHint: "Enable Google under Supabase → Authentication → Providers with your OAuth client; add this app's origin to Redirect URLs." };
  }

  async updateSso(orgId: string, ssoDomain: string | null) {
    const clean = ssoDomain?.trim().toLowerCase().replace(/^@/, "") || null;
    await this.db.update(organizations).set({ ssoDomain: clean, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return this.getSso(orgId);
  }

  /** The tenant check behind OrgGuard: is this user a member of this org? */
  async membershipIn(userId: string, orgId: string) {
    return this.db.query.memberships.findFirst({
      where: and(eq(memberships.userId, userId), eq(memberships.organizationId, orgId)),
    });
  }

  /**
   * Creates an organization and makes the caller its owner. Needed because a
   * brand-new signup belongs to nothing yet and every other route is org-scoped.
   */
  async createOrganization(userId: string, name: string) {
    const slug = await this.uniqueSlug(name);

    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name, slug, ownerId: userId })
        .returning();
      await tx.insert(memberships).values({
        organizationId: org!.id,
        userId,
        role: "owner" satisfies Role,
      });
      return { id: org!.id, name: org!.name, slug: org!.slug, role: "owner" as Role };
    });
  }

  private async uniqueSlug(name: string) {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "workspace";

    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const clash = await this.db.query.organizations.findFirst({
        where: eq(organizations.slug, candidate),
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  /** Assembles the object handlers receive from `@Auth()`. */
  toContext(
    user: { id: string; authSubject: string; email: string; name: string },
    org?: { organizationId: string; role: Role },
  ): AuthContext {
    return {
      userId: user.id,
      subject: user.authSubject,
      email: user.email,
      name: user.name,
      orgId: org?.organizationId ?? "",
      role: org?.role ?? "guest",
    };
  }
}
