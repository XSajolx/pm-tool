import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * False until the two VITE_SUPABASE_* vars are filled in. We check instead of
 * throwing at import time so a missing key shows a readable setup screen rather
 * than a blank page.
 */
export const supabaseConfigured = Boolean(url && anonKey);

/**
 * Supabase is our identity provider only — every bit of app data still comes
 * from our own API. supabase-js keeps the session in localStorage and refreshes
 * the access token in the background, which is why `api.ts` can simply ask it
 * for the current token on each request.
 */
// `||`, not `??`: an unset Vite var arrives as an empty string, and createClient
// throws on a blank key — which would take the whole app down at import time
// before the setup notice could explain what's missing.
export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
