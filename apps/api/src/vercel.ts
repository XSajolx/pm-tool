import "./vercel-env.js";
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";

/**
 * Serverless entry for Vercel. The whole REST API is one function: Nest is
 * booted once per warm instance onto a bare Express app and every request is
 * handed to it. The socket.io gateway still initialises but has no listening
 * server to attach to, so real-time chat fan-out is unavailable on this host —
 * the REST endpoints (which are the source of truth) are unaffected.
 */
let ready: Promise<express.Express> | undefined;

async function create() {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ["error", "warn", "log"],
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return server;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= create();
  const server = await ready;
  server(req, res);
}
