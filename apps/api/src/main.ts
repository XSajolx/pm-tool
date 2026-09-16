import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";

async function bootstrap() {
  // rawBody: Stripe webhook signatures (row 129) are computed over the exact bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  const port = Number(process.env.API_PORT ?? 3333);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🟢 API listening on http://localhost:${port}/api`);
}

void bootstrap();
