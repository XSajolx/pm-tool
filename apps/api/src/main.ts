import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");
  // Request bodies are validated per-route with ZodValidationPipe (see common/),
  // so Nest's class-validator ValidationPipe is intentionally not used.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 3333);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🟢 API listening on http://localhost:${port}/api`);
}

void bootstrap();
