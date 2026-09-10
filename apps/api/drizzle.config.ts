import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const localEnv = resolve(process.cwd(), ".env");
const rootEnv = resolve(process.cwd(), "../../.env");
config({ path: existsSync(localEnv) ? localEnv : rootEnv });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
