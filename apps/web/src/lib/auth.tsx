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
import { api, API_CONFIGURED, setActiveOrg, getActiveOrg, type AuthedUser, type Membership } from "./api.js";

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
    loadMe()
      .catch((err) => {
        // A token we can't exchange for a user is useless — drop it rather than
        // leaving the app in a half-signed-in state.
        console.error("Failed to load profile", err);
        void supabase.auth.signOut();
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session, loadMe]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
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
      signOut,
      switchOrg,
      createOrganization,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
