# Local Storage Completeness + Grounded Dashboard Chat — Research & Plan

Status: planning (2026-06-19). This document captures the research behind, and
the execution plan for, two linked pieces of work:

1. **Storage completeness + versioned migrations + round-trip tests** — persist
   every pull-request fact we fetch from GitHub, behind a real migration
   framework, and prove with tests that the data round-trips correctly
   (fetch → store → read).
2. **A persistent, board-scoped chat overlay on the dashboard** — built on an
   existing chat library, working with both the Codex CLI and OpenRouter,
   answering questions strictly from the board-filtered pull requests, with the
   conversation persisted in SQLite.

## How the system works today (research findings)

### Data layer

- The canonical schema lives in `packages/db/src/local-schema.ts`
  (`localDesktopSchemaSql`), a single `create table if not exists` blob plus a
  handful of indexes. The desktop app re-runs this blob statement-by-statement
  at startup (`splitSqlStatements` in `apps/desktop/src/desktop/tauri-data.ts`).
- **There are two divergent ingestion implementations of the same mapping**:
  - `packages/db/src/local-sqlite.ts` — synchronous `node:sqlite`, used by unit
    tests, the live-ingestion smoke test, and `scripts/`.
  - `apps/desktop/src/desktop/tauri-data.ts` — async `@tauri-apps/plugin-sql`,
    used by the actual app.
  They share intent but have drifted: the desktop copy stores `merged_at` and
  `status_check_summary_json`; the `packages/db` copy does not.
- **Migrations are ad-hoc.** `initializeDatabase` calls `migrateLegacyBoardItems`,
  `ensureReviewThreadLedgerColumns`, `ensurePullRequestSizeColumns`, and
  `dropOutdatedAiSummariesTable`. `packages/db` mirrors a subset in
  `initializeLocalDatabase`. There is no version ledger; each step re-checks
  `pragma table_info` every launch.
- **Fields fetched but dropped / schema columns never populated.** The
  `pull_requests` table declares `mergeable_state`, `review_decision`,
  `base_ref`, `head_ref`, `closed_at` — none are written. The
  `pull_request_check_runs` table exists but is never written (only the rollup
  summary JSON is stored). The GitHub snapshot
  (`GitHubPullRequestSnapshot`) also does not yet carry base/head ref names,
  `closed_at`, `review_decision`, or `mergeable_state`, so closing these gaps
  spans the fetch layer (`packages/github`) and both ingestion paths.

### AI layer (reusable for chat)

- Two provider adapters already exist and are unified behind
  `runStructuredAiCompletion(config, request)` in `tauri-data.ts`:
  - OpenRouter: `requestStructuredCompletion` (`ai/openrouter.ts`) — direct
    HTTPS from the user's machine with their key (Stronghold-stored).
  - Codex CLI: `requestCodexStructuredCompletion` (`ai/codex.ts`) — shells out
    via `@tauri-apps/plugin-shell` `Command.create("codex", args)`; the CLI owns
    its own ChatGPT-plan auth. Shell access is already allow-listed in
    `src-tauri/capabilities/default.json` for `codex`.
  - `requireActiveAiConfig` resolves provider + model + key, gated on
    `isAiModeActive`.
  - Both current callers force a **structured JSON-schema** response. Chat needs
    **free-form text**, so a parallel `runChatAiCompletion` is required.
- AI generations are cached in `ai_summaries` (kinds `pr-brief`, `ai-dashboard`;
  sentinel pull-request id `queue` for the board-wide dashboard), keyed by a
  content hash of the exact prompt + model.

### Board scope contract (mandatory for chat grounding)

- Per `CLAUDE.md` and `docs/ai-insights-dashboard-spec.md`: every user-facing
  surface and **every AI prompt** must derive its universe from the applied
  board filter, never an unfiltered store read. UI reads go through
  `use-board-inbox.ts` / `use-board-scoped-items.ts`; AI inputs additionally
  pass through `reviewer/board-scope.ts` (`selectBoardScopedItems`).
- The dashboard already builds a board-scoped projection:
  `buildAiDashboardInput(items)` over `useBoardScopedItems()`, enriched with
  per-PR discussion excerpts via `enrichAiDashboardInputWithComments` /
  `listDiscussionComments`. **This is exactly the corpus the chat must ground
  on** — reuse it.

### Prior-research constraints to honor

- Provider substrate is "one analysis-provider interface, multiple adapters"
  (codex + OpenRouter today). Keys live in Stronghold, never SQLite.
- AI is strictly additive and silent unless AI mode is on; no network calls when
  off; AI never reorders the queue or feeds classification; user-triggered only.
- Grounding contract (from `ai-insights-research.md`): feed only board PRs,
  deterministically ordered and capped; the normalizer drops any PR id the model
  names that was not in the input; AI text can never reference a PR the app
  cannot link. The chat applies the same id-allowlist discipline.
- Generated content must be persisted app-side in SQLite (OpenRouter caching is
  not persistence).

## Design decisions

### Chat library

Use **`@assistant-ui/react`** with a custom **`useLocalRuntime` ChatModelAdapter**.
Rationale: it is a headless, provider-agnostic React chat runtime (message
state, streaming, edit/regenerate, overlay-friendly primitives). The adapter's
`run({ messages })` is where we route to Codex or OpenRouter, so the same UI
works for both providers. We own persistence by seeding the runtime with the
thread's stored messages and writing each new turn to SQLite. This satisfies
"use an existing library" while keeping the provider abstraction and board
grounding entirely in our code. Styling reuses the existing Tailwind/shadcn
tokens.

### Grounding strategy: full board context, not RAG

A single user's board is small (the dashboard already caps at ~30 PRs). So we
feed the **entire board-scoped corpus** (the dashboard input + discussion
excerpts) as system context each turn, with strict instructions to answer only
from it and to say it does not have the information otherwise. This is more
reliable than embeddings/RAG at this scale and matches the project's
"keep it simple, no speculative infrastructure" discipline. The corpus is built
from the same board-scoped projection the dashboard uses, so the chat
physically cannot see off-board PRs. We additionally pass the allowed PR id set
so answers can be checked against it.

### Chat persistence

New tables (added via the migration framework):

- `chat_threads(id, board_fingerprint, title, created_at, updated_at, archived_at)`
- `chat_messages(id, thread_id, role, content, model, created_at)` —
  `role in ('user','assistant','system')`.

A thread is associated with the board filter fingerprint that was applied when
it was created, so reopening the overlay restores the matching conversation. V1
keeps it minimal: one active thread per board with the ability to start a new
one; history is retained.

### Migration framework

Introduce a versioned, idempotent migration ledger shared by both ingestion
paths:

- A `schema_migrations(id text primary key, name text, applied_at text)` table.
- An ordered list of migrations in `packages/db/src/migrations.ts`, each a
  `{ id, name, statements: string[] }`. Migrations are written **idempotently**
  (`create table if not exists`, guarded `add column`) because real databases
  already exist in the field with tables created by the old
  create-if-not-exists path and no ledger row.
- Two thin runners share the one migration list: a synchronous one for
  `node:sqlite` (`packages/db`) and an async one for the Tauri SQL plugin
  (`tauri-data.ts`). Each records applied ids in `schema_migrations` and skips
  already-applied ids. The existing ad-hoc `ensure*`/`migrateLegacy*` steps fold
  into numbered migrations.

This is the "first real migration" the schema doc anticipated.

## Execution plan (checkpoints, each committed independently)

1. **Migration framework.** Add `schema_migrations` + `migrations.ts` with the
   current schema decomposed into ordered, idempotent migrations. Wire both
   ingestion paths to the shared runner; delete the ad-hoc `ensure*` calls.
   Tests: fresh DB → all tables/columns/indexes present; simulated legacy DB
   (old shape, no ledger) → migrates cleanly and is recorded; re-running is a
   no-op.
2. **Storage completeness.** Extend `GitHubPullRequestSnapshot` + the token
   source to fetch base/head ref, `closed_at`, `review_decision` (from the
   GraphQL facts already fetched), `mergeable_state`, and individual check runs.
   Map them through `PullRequestItem` and persist in both ingestion paths,
   including populating `pull_request_check_runs`. Migration adds any missing
   columns. Tests: a fixture snapshot with every field set ingests and reads
   back identically (round-trip), including child tables.
3. **Round-trip + ingestion test suite.** A focused test that drives a mock
   GitHub source through the real sync into an in-memory `node:sqlite` DB and
   asserts the full projected shape (PR row, labels, assignees, review requests,
   reviews, threads + participants, review comments, issue comments, check runs,
   activity, board membership). This is the "right data in, stored right" proof.
4. **Chat data + provider plumbing.** Chat tables migration; `runChatAiCompletion`
   (text, multi-turn) for both providers (`ai/openrouter.ts` chat fn +
   `ai/codex.ts` chat fn); desktop bridge functions
   (`listChatThreads`, `getChatMessages`, `sendChatMessage`, `createChatThread`)
   that build the board-scoped grounding context and persist turns. Unit tests
   for the new provider functions and the grounding prompt builder.
5. **Chat overlay UI.** Install `@assistant-ui/react`; build a dashboard overlay
   (floating launcher + modal/sheet) wired to a `useLocalRuntime` adapter that
   calls the bridge. Gate on `isAiModeActive`. Persist + restore the thread.
   QA against the dashboard; verify grounding (answers only about board PRs,
   refuses off-board questions).

## Out of scope (deliberately deferred)

- Webhooks / background chat streaming infrastructure.
- RAG/embeddings (full-context grounding suffices at board scale).
- Multi-device or shared chat sync.
- Unifying the two ingestion code paths into one (tracked as a risk; mitigated
  by sharing the migration list and adding cross-path round-trip tests). A full
  merge is a larger refactor than this goal warrants.
