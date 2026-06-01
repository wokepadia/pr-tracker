# PR Tracker

Single-user reviewer inbox for GitHub pull requests.

V1 is intentionally focused on basic plumbing:

- GitHub-shaped domain primitives.
- Deterministic reviewer workflow classification.
- Hono API with GitHub webhook verification scaffold.
- One-shot GitHub App sync worker for PR state and review backfill.
- Vite + React + TanStack reviewer inbox UI.
- MikroORM/PostgreSQL schema and migration.
- Worker entrypoint for future sync/reconciliation jobs.
- Sample data fallback so the app runs before GitHub App credentials are configured.

Generated summaries, LLM-dependent ranking, CI/check-state tracking, team workflows, and authored-PR management are out of scope for V1.

## Stack

- pnpm workspace
- TypeScript
- Vite + React
- TanStack Router, Query, and Table
- Hono API
- MikroORM + PostgreSQL
- Octokit GitHub App primitives
- Vitest

## Local Development

Install dependencies:

```sh
pnpm install
```

Start the API and web app:

```sh
pnpm dev
```

The web app runs at:

```text
http://127.0.0.1:5173
```

The API runs at:

```text
http://127.0.0.1:4000
```

Run checks:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm db:smoke:ingest
pnpm db:smoke:sync
```

Run the GitHub App sync worker once after setting database and GitHub App
environment variables:

```sh
pnpm --filter @pr-tracker/worker sync
```

## Database

Copy the example environment file and set `DATABASE_URL` when using PostgreSQL:

```sh
cp .env.example .env
```

Run migrations:

```sh
pnpm db:migrate
```

Seed deterministic sample data into Postgres:

```sh
pnpm db:seed:sample
```

Smoke-test the database-backed repository:

```sh
pnpm --filter @pr-tracker/api db:smoke
```

The API serves in-memory sample data by default. To read from Postgres instead, set:

```text
PR_TRACKER_USE_DATABASE=true
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

The database-backed path currently supports the reviewer inbox, PR detail reads, local seen state, webhook delivery persistence, and one-shot GitHub App sync.

## Web/API URL Configuration

In development, Vite proxies `/api` to the Hono API. In production, either:

- serve the frontend and API behind the same origin and reverse proxy `/api` and `/webhooks`, or
- set `VITE_API_BASE_URL` at build time.

## GitHub App Environment

Set these values when wiring a real GitHub App:

```text
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
GITHUB_INSTALLATION_ID=
GITHUB_CLOSED_LOOKBACK_DAYS=30
```

Without those values, the webhook endpoint accepts local development payloads without signature verification. With those values present, GitHub webhook signatures are verified.

`GITHUB_INSTALLATION_ID` is optional. When omitted, the worker iterates every installation visible to the GitHub App.
The worker always syncs open PRs, reconciles recently updated closed or merged PRs, and checks any locally known open PRs that did not appear in the list response. `GITHUB_CLOSED_LOOKBACK_DAYS` must be a positive integer; unset, zero, negative, or invalid values use the default 30-day closed/merged lookback window.

## VPS Deployment Shape

Recommended production topology:

```text
Caddy or Nginx
  - serves apps/web/dist
  - reverse proxies /api and /webhooks to the Hono API

Node process: api
  - pnpm --filter @pr-tracker/api start

Node process: worker
  - pnpm --filter @pr-tracker/worker start

PostgreSQL
  - app data and webhook/sync records
```

Use Docker Compose or systemd services. Run `pnpm build` and `pnpm db:migrate` during deploy before restarting API/worker processes.
