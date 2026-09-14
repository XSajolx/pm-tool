import type { membershipRole } from "../../db/schema.js";

export type Role = (typeof membershipRole.enumValues)[number];

/**
 * Everything the request handlers are allowed to trust. Assembled by the guards:
 * `AuthGuard` proves who the caller is (verified JWT → local user row), then
 * `OrgGuard` proves which tenant they may act in (membership lookup).
 */
export interface AuthContext {
  /** Our own `users.id` — NOT the provider's subject. */
  userId: string;
  /** The `sub` claim from Supabase, stored as `users.auth_subject`. */
  subject: string;
  email: string;
  name: string;
  /** Present on every org-scoped route (i.e. everything but /auth/me). */
  orgId: string;
  role: Role;
  /** Row 80: how the session was minted - "google", "email", ... (from Supabase app_metadata). */
  provider?: string;
  /** Row 81: second-factor state of this request's session. */
  mfa?: { enrolled: boolean; verified: boolean; sessionId: string | null };
}

declare module "express" {
  interface Request {
    auth?: AuthContext;
  }
}
