import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { integrations, memberships } from "../../db/schema.js";
import { MailerService } from "../notifications/mailer.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { ActivityService } from "../activity/activity.service.js";

export type Provider = "google_drive" | "dropbox";
export const PROVIDERS: Provider[] = ["google_drive", "dropbox"];

/** What each provider needs in the API .env before "Connect" works. */
const ENV: Record<Provider, { id: string; secret: string; label: string }> = {
  google_drive: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", label: "Google Drive" },
  dropbox: { id: "DROPBOX_APP_KEY", secret: "DROPBOX_APP_SECRET", label: "Dropbox" },
};

/* ---- token encryption at rest (AES-256-GCM, key from INTEGRATIONS_SECRET or the DB url) ---- */
const key = () => createHash("sha256").update(process.env.INTEGRATIONS_SECRET ?? process.env.DATABASE_URL ?? "pm-tool").digest();
export function seal(plain: string | null | undefined) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}
export function open(sealed: string | null | undefined) {
  if (!sealed) return null;
  const [iv, tag, enc] = sealed.split(".");
  if (!iv || !tag || !enc) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Base URLs: the API (for OAuth redirects) and the web app (where to land afterwards). */
export function apiBase() {
  return (process.env.PUBLIC_API_URL ?? process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3333}`).replace(/\/$/, "");
}
export function webBase() {
  const first = (process.env.WEB_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",")[0]!.trim();
  return first.replace(/\/$/, "");
}

interface PendingState { orgId: string; userId: string; provider: Provider; expires: number }

/**
 * Row 112: connect Google Drive / Dropbox once per workspace. Standard OAuth2
 * code flow; refresh tokens are kept so the link survives. Row 116 reads
 * `check()` for the health page.
 */
@Injectable()
export class IntegrationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationsService.name);
  private timer: NodeJS.Timeout | null = null;
  /** OAuth state nonces (single-process; fine for one API instance). */
  private readonly pending = new Map<string, PendingState>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly activity: ActivityService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Row 116: re-check every connected account hourly so a broken link is never silent. */
  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    setTimeout(() => void this.sweep(), 20_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    try {
      const rows = await this.db.query.integrations.findMany({ where: eq(integrations.status, "connected") });
      for (const row of rows) await this.check(row.organizationId, row.provider as Provider).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`integration sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Row 116: one view of every service the workspace depends on - the OAuth
   * connections plus email, calendar and e-signature - with status, last
   * check and what is needed to fix it.
   */
  async health(orgId: string) {
    const providers = await this.list(orgId);
    const mail = this.mailer.lastResult;
    const email = {
      id: "email",
      label: "Email (Resend)",
      status: !this.mailer.configured ? "not_set_up" : mail && !mail.ok ? "failing" : "connected",
      detail: !this.mailer.configured ? "Add RESEND_API_KEY (and MAIL_FROM) to the API .env" : mail ? `${mail.what === "send" ? "Last email" : "Last check"} ${mail.ok ? "succeeded" : "failed"}` : "Configured - no email sent yet",
      lastCheckedAt: mail?.at ?? null,
      lastError: mail?.ok === false ? mail.error : null,
      canCheck: this.mailer.configured,
    };
    const google = providers.find((p) => p.provider === "google_drive");
    const calendar = {
      id: "calendar",
      label: "Google Calendar",
      status: "not_set_up",
      detail: google?.status === "connected" ? "Drive is connected; calendar sync is not part of this build yet" : "Comes with the Google connection once calendar sync is built",
      lastCheckedAt: null,
      lastError: null,
      canCheck: false,
    };
    const esign = {
      id: "esign",
      label: "E-signature",
      status: "not_set_up",
      detail: "Proposals are accepted from the share page (row 55); a DocuSign / Dropbox Sign connection is not part of this build",
      lastCheckedAt: null,
      lastError: null,
      canCheck: false,
    };
    return { providers, services: [email, calendar, esign] };
  }

  async checkEmail(orgId: string) {
    await this.mailer.check();
    return this.health(orgId);
  }

  configured(provider: Provider) {
    const e = ENV[provider];
    return Boolean(process.env[e.id] && process.env[e.secret]);
  }

  private redirectUri(provider: Provider) {
    return `${apiBase()}/api/integrations/${provider}/callback`;
  }

  async list(orgId: string) {
    const rows = await this.db.query.integrations.findMany({ where: eq(integrations.organizationId, orgId), with: { connectedBy: { columns: { id: true, name: true } } } });
    return PROVIDERS.map((provider) => {
      const row = rows.find((x) => x.provider === provider);
      const e = ENV[provider];
      return {
        provider,
        label: e.label,
        configured: this.configured(provider),
        requiredEnv: [e.id, e.secret],
        status: row ? row.status : "disconnected",
        accountEmail: row?.accountEmail ?? null,
        accountName: row?.accountName ?? null,
        connectedBy: row?.connectedBy ?? null,
        connectedAt: row?.connectedAt?.toISOString() ?? null,
        lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
      };
    });
  }

  /** Step 1: build the provider's consent URL. The state nonce ties the callback back to this org + user. */
  start(orgId: string, userId: string, provider: Provider) {
    if (!PROVIDERS.includes(provider)) throw new BadRequestException("Unknown provider");
    const e = ENV[provider];
    if (!this.configured(provider)) throw new BadRequestException(`${e.label} isn't set up yet - add ${e.id} and ${e.secret} to the API .env`);
    const state = randomBytes(18).toString("base64url");
    this.pending.set(state, { orgId, userId, provider, expires: Date.now() + 10 * 60_000 });
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    const redirect = this.redirectUri(provider);
    if (provider === "google_drive") {
      const q = new URLSearchParams({
        client_id: process.env[e.id]!,
        redirect_uri: redirect,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/drive.readonly openid email profile",
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
    }
    const q = new URLSearchParams({ client_id: process.env[e.id]!, redirect_uri: redirect, response_type: "code", token_access_type: "offline", state });
    return { url: `https://www.dropbox.com/oauth2/authorize?${q}` };
  }

  /** Step 2: the provider sends the browser back here with a code. Returns where to send the browser next. */
  async callback(provider: Provider, code: string | undefined, state: string | undefined, error?: string) {
    const back = (q: string) => `${webBase()}/settings?section=connections&${q}`;
    const pend = state ? this.pending.get(state) : undefined;
    if (!pend || pend.provider !== provider || pend.expires < Date.now()) return back(`error=${encodeURIComponent("Sign-in expired, try again")}`);
    this.pending.delete(state!);
    if (error || !code) return back(`error=${encodeURIComponent(error || "No code returned")}`);
    try {
      const tokens = await this.exchange(provider, code);
      const account = await this.account(provider, tokens.accessToken);
      await this.db
        .insert(integrations)
        .values({
          organizationId: pend.orgId,
          provider,
          status: "connected",
          accountEmail: account.email,
          accountName: account.name,
          accessToken: seal(tokens.accessToken),
          refreshToken: seal(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          scopes: tokens.scope ?? null,
          connectedById: pend.userId,
          connectedAt: new Date(),
          lastCheckedAt: new Date(),
          lastError: null,
        })
        .onConflictDoUpdate({
          target: [integrations.organizationId, integrations.provider],
          set: {
            status: "connected",
            accountEmail: account.email,
            accountName: account.name,
            accessToken: seal(tokens.accessToken),
            refreshToken: seal(tokens.refreshToken) ?? undefined,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scope ?? null,
            connectedById: pend.userId,
            connectedAt: new Date(),
            lastCheckedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          },
        });
      await this.activity.record({ orgId: pend.orgId, actorId: pend.userId, entityType: "integration", entityId: pend.orgId, action: "integration_connected", changes: [{ field: "provider", from: null, to: provider }, { field: "account", from: null, to: account.email }] });
      return back(`connected=${provider}`);
    } catch (err) {
      this.logger.warn(`${provider} connect failed: ${(err as Error).message}`);
      return back(`error=${encodeURIComponent((err as Error).message)}`);
    }
  }

  async disconnect(orgId: string, provider: Provider) {
    const row = await this.db.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.provider, provider)) });
    if (!row) throw new NotFoundException("Not connected");
    // Best effort: tell the provider to drop the grant.
    const token = open(row.accessToken);
    try {
      if (provider === "google_drive" && token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
      if (provider === "dropbox" && token) await fetch("https://api.dropboxapi.com/2/auth/token/revoke", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    } catch { /* offline is fine */ }
    await this.db
      .update(integrations)
      .set({ status: "disconnected", accessToken: null, refreshToken: null, expiresAt: null, lastError: null, updatedAt: new Date() })
      .where(eq(integrations.id, row.id));
    return this.list(orgId);
  }

  /** Row 116: ping the provider and record the outcome. */
  async check(orgId: string, provider: Provider) {
    const row = await this.db.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.provider, provider)) });
    if (!row || row.status === "disconnected") throw new NotFoundException("Not connected");
    try {
      const token = await this.freshToken(orgId, provider);
      await this.account(provider, token);
      await this.db.update(integrations).set({ status: "connected", lastCheckedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(integrations.id, row.id));
    } catch (err) {
      const msg = (err as Error).message;
      const status = /invalid_grant|expired|revoked|401|unauthori[sz]ed/i.test(msg) ? "needs_reconnect" : "failing";
      await this.db.update(integrations).set({ status, lastCheckedAt: new Date(), lastError: msg, updatedAt: new Date() }).where(eq(integrations.id, row.id));
      // Row 116: tell the admins once, when the status changes.
      if (row.status === "connected") {
        const admins = await this.db.query.memberships.findMany({ where: eq(memberships.organizationId, orgId), columns: { userId: true, role: true } });
        for (const m of admins.filter((x) => x.role === "owner" || x.role === "admin")) {
          await this.notifications.notifyDirect({
            orgId,
            receiverId: m.userId,
            entityType: "integration",
            entityId: row.id,
            verb: "integration_failing",
            title: `${ENV[provider].label} ${status === "needs_reconnect" ? "needs reconnecting" : "is failing"}`,
            body: `${msg} - open Settings › Connections to reconnect or retry.`,
            data: { provider, link: "/settings?section=connections" },
          }).catch(() => undefined);
        }
      }
    }
    return this.list(orgId);
  }

  /** A usable access token, refreshed when it is about to expire. Throws when the grant is gone. */
  async freshToken(orgId: string, provider: Provider) {
    const row = await this.db.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.provider, provider)) });
    if (!row || row.status === "disconnected") throw new NotFoundException(`${ENV[provider].label} isn't connected`);
    const access = open(row.accessToken);
    if (access && (!row.expiresAt || row.expiresAt.getTime() > Date.now() + 60_000)) return access;
    const refresh = open(row.refreshToken);
    if (!refresh) throw new Error("expired: no refresh token");
    const tokens = await this.refresh(provider, refresh);
    await this.db
      .update(integrations)
      .set({ accessToken: seal(tokens.accessToken), expiresAt: tokens.expiresAt, updatedAt: new Date(), ...(tokens.refreshToken ? { refreshToken: seal(tokens.refreshToken) } : {}) })
      .where(eq(integrations.id, row.id));
    return tokens.accessToken;
  }

  /* ---------------- provider plumbing ---------------- */

  private async exchange(provider: Provider, code: string) {
    const e = ENV[provider];
    const body = new URLSearchParams({ code, client_id: process.env[e.id]!, client_secret: process.env[e.secret]!, redirect_uri: this.redirectUri(provider), grant_type: "authorization_code" });
    const url = provider === "google_drive" ? "https://oauth2.googleapis.com/token" : "https://api.dropboxapi.com/oauth2/token";
    return this.tokenCall(url, body);
  }

  private async refresh(provider: Provider, refreshToken: string) {
    const e = ENV[provider];
    const body = new URLSearchParams({ refresh_token: refreshToken, client_id: process.env[e.id]!, client_secret: process.env[e.secret]!, grant_type: "refresh_token" });
    const url = provider === "google_drive" ? "https://oauth2.googleapis.com/token" : "https://api.dropboxapi.com/oauth2/token";
    return this.tokenCall(url, body);
  }

  private async tokenCall(url: string, body: URLSearchParams) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error_description ?? json.error_summary ?? json.error ?? `token call failed (${res.status})`));
    const expiresIn = Number(json.expires_in ?? 3600);
    return {
      accessToken: String(json.access_token),
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scope: typeof json.scope === "string" ? json.scope : null,
    };
  }

  private async account(provider: Provider, accessToken: string): Promise<{ email: string | null; name: string | null }> {
    if (provider === "google_drive") {
      const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`Google Drive ${res.status}`);
      const j = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
      return { email: j.user?.emailAddress ?? null, name: j.user?.displayName ?? null };
    }
    const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Dropbox ${res.status}`);
    const j = (await res.json()) as { email?: string; name?: { display_name?: string } };
    return { email: j.email ?? null, name: j.name?.display_name ?? null };
  }
}
