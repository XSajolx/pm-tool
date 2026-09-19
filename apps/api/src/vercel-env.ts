/**
 * Platform defaults for the Vercel deployment. Imported first by vercel.ts so
 * they are in place before any module reads process.env at load time.
 * Anything set in Vercel > Project > Environment Variables wins (`??=` only
 * fills blanks). Secrets (DATABASE_URL, DATABASE_MIGRATE_URL, S3_*, RESEND_*)
 * are never defaulted here — they must come from the project settings.
 */
process.env.NODE_ENV ??= "production";
// Vercel's filesystem is read-only except /tmp; without S3_* this is where uploads land (ephemeral).
process.env.UPLOAD_DIR ??= "/tmp/uploads";
// One function instance = one small pool; DATABASE_URL should be the transaction pooler (6543).
process.env.DB_POOL_MAX ??= "2";
// Web app on Vercel (pm-tool-web); the old GitHub Pages origin stays allowed.
process.env.CORS_ORIGIN ??= "https://pm-tool-web-beta.vercel.app,https://xsajolx.github.io";
process.env.WEB_URL ??= "https://pm-tool-web-beta.vercel.app";
// Supabase is the identity provider; the URL is public (tokens are verified against its JWKS).
process.env.SUPABASE_URL ??= "https://iuybckgroeolqftdsmqt.supabase.co";
// Vercel injects the production host (no scheme); file links and OAuth callbacks are built from it.
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
if (host) process.env.PUBLIC_API_URL ??= `https://${host}`;
