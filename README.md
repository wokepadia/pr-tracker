# Review Ninja

Single-user reviewer inbox for GitHub pull requests.

V1 is intentionally focused on basic plumbing:

- GitHub-shaped domain primitives.
- Deterministic reviewer workflow classification.
- Hono API with deterministic GitHub webhook payload normalization scaffold.
- One-shot GitHub token sync worker for PR state and review backfill.
- Vite + React + TanStack reviewer inbox UI.
- MikroORM/PostgreSQL schema and migration.
- Worker entrypoint for future sync/reconciliation jobs.
- Sample data fallback so the app runs before GitHub token credentials are configured.

Generated summaries, LLM-dependent ranking, CI/check-state tracking, team workflows, and authored-PR management are out of scope for V1.

## Stack

- pnpm workspace
- TypeScript
- Vite + React
- TanStack Router, Query, and Table
- Hono API
- MikroORM + PostgreSQL
- GitHub REST API token source
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

Run the GitHub token sync worker once after setting database and GitHub token
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

The database-backed path currently supports the reviewer inbox, PR detail reads, local seen state, webhook delivery persistence, and one-shot GitHub token sync.

## Web/API URL Configuration

In development, Vite proxies `/api` to the Hono API. In production, either:

- serve the frontend and API behind the same origin and reverse proxy `/api` and `/webhooks`, or
- set `VITE_API_BASE_URL` at build time.

## GitHub Token Environment

Set these values when wiring real GitHub data:

```text
GITHUB_TOKEN=
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
GITHUB_API_BASE_URL=https://api.github.com
GITHUB_CLOSED_LOOKBACK_DAYS=30
```

A read-only fine-grained personal access token is enough for the current reviewer inbox. Scope it to the selected repositories and grant repository `Pull requests` read access. The app does not write reviews or comments in V1.

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
