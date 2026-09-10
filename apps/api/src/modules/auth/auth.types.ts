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
}

declare module "express" {
  interface Request {
    auth?: AuthContext;
  }
}
