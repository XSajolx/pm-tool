# PM Tool

A ClickUp-style project management tool for 4S Digital. TypeScript end-to-end,
built to scale to thousands of concurrent users.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, front and back |
| Repo | pnpm workspaces + Turborepo |
| Frontend | React + Vite, TanStack Router + TanStack Query |
| UI | Tailwind + shadcn/ui |
| Backend | Node + NestJS |
| API | REST (OpenAPI spec + generated client — phase 2) |
| Database | PostgreSQL (Neon / Supabase / RDS) |
| ORM | Drizzle |
| Auth | Managed (Clerk / Auth0 / Supabase Auth); our `users` row keyed to the token `sub` |
| Files | S3-compatible (Cloudflare R2 / S3) |
| Jobs | pg-boss → BullMQ + Redis at phase 2 |
| Email | Postmark |
| Observability | Sentry + pino + OpenTelemetry |
| CI/CD | GitHub Actions |
| Hosting | Containers on Fly.io / Render / Railway |
| Testing | Vitest + Supertest + Playwright |

## Layout

```
pm-tool/
├─ apps/
│  ├─ api/   NestJS + Drizzle  (the data model lives in src/db/schema.ts)
│  └─ web/   React + Vite + Tailwind + TanStack
└─ packages/ (shared types / OpenAPI client — phase 2)
```

## The data model

`Organization → Space → Folder → List → Task → Subtask`, plus statuses, assignees,
tags, comments, attachments, custom fields, and an activity log. **Every table
carries `organization_id`** — that column is the tenant boundary (and the natural
key for Postgres Row-Level Security and, eventually, sharding). See
`apps/api/src/db/schema.ts`.

## Getting it running

1. **Install**
   ```bash
   pnpm install
   ```
2. **Database** — create a free Postgres (Neon or Supabase), then:
   ```bash
   cp .env.example .env          # paste your DATABASE_URL
   pnpm db:push                  # create tables from the Drizzle schema
   pnpm db:seed                  # demo org + tasks; prints ids to use below
   ```
3. **Wire the web demo ids** — copy the printed `x-org-id`, `x-user-id`, `listId`
   into `apps/web/.env` (`cp apps/web/.env.example apps/web/.env`).
4. **Run**
   ```bash
   pnpm dev                      # api on :3333, web on :5173
   ```

## Scaling path (why this reaches thousands of users)

- **Stateless API** → run N NestJS replicas behind a load balancer.
- **Postgres** → one primary for writes, read-replicas for reads; shard by
  `organization_id` only if a single tenant gets huge.
- **Realtime** (live task updates) → phase 2: a WebSocket gateway backed by Redis
  pub/sub, or a managed service (Ably / Supabase Realtime).
- **Background jobs** (notifications, recurring tasks) → pg-boss now, BullMQ+Redis
  when volume grows.
- **Files** → S3/R2 + CDN, so attachment bytes never touch the app tier.
