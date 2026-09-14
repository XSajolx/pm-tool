import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "./supabase.js";
import { api, API_CONFIGURED, API_URL, setActiveOrg, getActiveOrg, type AuthedUser, type Membership, ApiError } from "./api.js";

interface AuthState {
  /** null while we're still restoring a persisted session. */
  session: Session | null;
  user: AuthedUser | null;
  memberships: Membership[];
  activeOrgId: string | null;
  /** The caller's role in the active org — drives what the UI offers. */
  role: Membership["role"] | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<{ needsEmailConfirm: boolean }>;
  /** Row 80: Google Workspace sign-in via Supabase OAuth (redirects away and back). */
  signInWithGoogle: () => Promise<void>;
  /** Row 79: e-mail a reset link; the link lands on /reset-password. */
  resetPassword: (email: string) => Promise<void>;
  /** Row 79: set a new password for the current (recovery or normal) session. */
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchOrg: (orgId: string) => void;
  createOrganization: (name: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Owns the session and the "who am I here" answer.
 *
 * Two separate identities are in play: Supabase's (the token) and ours (the
 * `users` row the API provisions on first sign-in). `/auth/me` is what bridges
 * them, so we call it whenever a session appears and treat its result — not the
 * token — as the current user for anything the app renders.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(getActiveOrg());
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  // Restore any persisted session, then follow auth changes for the app's life.
  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (!data.session) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setUser(null);
        setMemberships([]);
        setActiveOrg(null);
        setActiveOrgIdState(null);
        queryClient.clear();
        setLoading(false);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [queryClient]);

  const loadMe = useCallback(async () => {
    const me = await api.me();
    setUser(me.user);
    setMemberships(me.memberships);

    // Keep the stored org only if it's still one the user belongs to.
    const stored = getActiveOrg();
    const valid = me.memberships.find((m) => m.organizationId === stored);
    const chosen = valid?.organizationId ?? me.memberships[0]?.organizationId ?? null;
    setActiveOrg(chosen);
    setActiveOrgIdState(chosen);
  }, []);

  // Resolve our own user record once a token exists.
  useEffect(() => {
    if (!session) return;
    if (!API_CONFIGURED) {
      // Preview deployment: no API to provision against. Show who Supabase says
      // you are and let the shell render; every data screen explains itself.
      const email = session.user.email ?? "";
      const meta = session.user.user_metadata as { name?: string } | undefined;
      setUser({ id: session.user.id, email, name: meta?.name ?? email.split("@")[0] ?? "You" });
      setMemberships([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    // Only a rejected token means the session is useless. A network blip or a
    // restarting API is retried for a while instead of signing the user out.
    const attempt = async (tries: number): Promise<void> => {
      try {
        await loadMe();
      } catch (err) {
        if (!active) return;
        const status = err instanceof ApiError ? err.status : -1;
        if (status === 401 || status === 403) {
          console.error("Session rejected by the API — signing out", err);
          void supabase.auth.signOut();
          return;
        }
        if (tries >= 15) {
          console.error("Failed to load profile after retries", err);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
        if (active) return attempt(tries + 1);
      }
    };
    void attempt(0).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [session, loadMe]);

  // Row 79: sign in through our API so repeated failures lock the address
  // server-side; the API hands back the Supabase session for the browser to
  // adopt. If the API is unreachable (static preview), fall back to Supabase.
  const signIn = useCallback(async (email: string, password: string) => {
    let viaApi: Response | null = null;
    if (API_CONFIGURED) {
      try {
        viaApi = await fetch(`${API_URL}/api/auth/sign-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
      } catch {
        viaApi = null;
      }
    }
    if (viaApi) {
      const body = (await viaApi.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; message?: string | string[] };
      if (!viaApi.ok || !body.access_token || !body.refresh_token) {
        const msg = Array.isArray(body.message) ? body.message.join(", ") : body.message;
        throw new Error(msg || "Sign-in failed");
      }
      const { error } = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
      if (error) throw new Error(error.message);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw new Error(/not enabled|unsupported provider/i.test(error.message) ? "Google sign-in isn't switched on yet - an admin needs to enable the Google provider in Supabase." : error.message);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
    });
    if (error) throw new Error(error.message);
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
  }, []);

  const signUp = useCallback(async (name: string, email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        // Confirmation links must come back to wherever the app is served
        // (localhost in dev, https://xsajolx.github.io/pm-tool/ on Pages);
        // the origin also has to be on Supabase's Redirect URLs allow-list.
        emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      },
    });
    if (error) throw new Error(error.message);
    // With "Confirm email" enabled, Supabase returns a user but no session.
    return { needsEmailConfirm: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const switchOrg = useCallback(
    (orgId: string) => {
      setActiveOrg(orgId);
      setActiveOrgIdState(orgId);
      // Cached data belongs to the previous tenant — never show it under another.
      queryClient.clear();
    },
    [queryClient],
  );

  const createOrganization = useCallback(
    async (name: string) => {
      const org = await api.createOrganization(name);
      setActiveOrg(org.id);
      setActiveOrgIdState(org.id);
      await loadMe();
      queryClient.clear();
    },
    [loadMe, queryClient],
  );

  const value = useMemo<AuthState>(
    () => ({
      session,
      user,
      memberships,
      activeOrgId,
      role: memberships.find((m) => m.organizationId === activeOrgId)?.role ?? null,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      resetPassword,
      updatePassword,
      signOut,
      switchOrg,
      createOrganization,
    }),
    [
      session,
      user,
      memberships,
      activeOrgId,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      resetPassword,
      updatePassword,
      signOut,
      switchOrg,
      createOrganization,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
