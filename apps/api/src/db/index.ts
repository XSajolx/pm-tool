import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Load env before reading it. cwd is apps/api when run via pnpm --filter, so the
// monorepo-root .env is two levels up; prefer a local apps/api/.env if one exists.
const localEnv = resolve(process.cwd(), ".env");
const rootEnv = resolve(process.cwd(), "../../.env");
config({ path: existsSync(localEnv) ? localEnv : rootEnv });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

// A single pooled client per process. Behind a load balancer each API replica
// keeps its own small pool; the DB (Neon/Supabase/RDS) handles the aggregate.
// Serverless hosts should set DB_POOL_MAX low (1-2) and point DATABASE_URL at
// Supabase's transaction pooler (port 6543), which cannot handle prepared
// statements — hence `prepare` is switched off for that port.
const client = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  prepare: !/:6543\//.test(connectionString),
});

export const db = drizzle(client, { schema });
export { schema };
export type DB = typeof db;
