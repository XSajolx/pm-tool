import type { INestApplication } from "@nestjs/common";

/**
 * Everything that must be applied to the Nest app regardless of how it is hosted
 * (long-running process in main.ts, or a serverless handler in vercel.ts).
 */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix("api");
  // Request bodies are validated per-route with ZodValidationPipe (see common/),
  // so Nest's class-validator ValidationPipe is intentionally not used.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()) ?? "http://localhost:5173",
    credentials: true,
    // Row 117: the browser needs the download filename.
    exposedHeaders: ["Content-Disposition"],
  });
}
