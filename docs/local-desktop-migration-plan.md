# Local Desktop Migration Plan

This plan tracks the migration from the current web/API prototype toward a
local-only desktop V1 backed by SQLite. The schema direction is documented in
[local-desktop-database-schema.md](local-desktop-database-schema.md), but the
implementation should stay pragmatic when the current codebase needs a smaller
intermediate step.

## Target Shape

- The app keeps running as the current local web UI plus local API while storage
  moves underneath it.
- SQLite becomes the durable store for GitHub cache data and board state.
- Browser `localStorage` stops owning board labels, item placement, pinned,
  muted, snoozed, and column width state.
- GitHub credentials are not stored in SQLite. V1 can continue using the
  existing local settings/keychain boundary until the desktop shell work starts.
- Core reviewer workflows continue to work in the in-app browser during the
  migration.

## Checkpoints

### 1. Add Local SQLite Storage Foundation

Create a local SQLite module in `@pr-tracker/db` that can initialize the schema,
open the configured database file, and seed/read sample GitHub data. Keep the
existing Postgres code temporarily so small commits stay reviewable.

Verification:

- SQLite schema applies to an empty database.
- Sample GitHub facts can be inserted and read.
- Package typecheck/tests pass.

### 2. Serve Reviewer Inbox From SQLite

Add an API repository backed by the local SQLite store. The repository should
load common GitHub facts from SQLite and derive the reviewer inbox through the
existing workflow classifier. Mark-seen should write to board/local state in
SQLite.

Verification:

- `/api/reviewer-inbox` returns the same useful sample inbox without Postgres.
- `/api/pull-requests/:id` works.
- `/api/pull-requests/:id/seen` persists across requests.
- API tests cover the SQLite repository.

### 3. Move Board State To SQLite API

Add API endpoints for board columns, item state, item order, and column width.
Update the web UI to use those endpoints instead of browser `localStorage` for
board state.

Verification:

- Add label persists after reload.
- Delete label moves items to a fallback column and persists.
- Dragging a card between columns persists after reload.
- Pin, mute, snooze, and restore persist after reload.
- Column resizing persists after reload.

### 4. Connect GitHub Sync To Local Cache

Adapt current GitHub ingestion/sync paths to write into SQLite cache tables.
Keep the current local GitHub settings flow as the credential source for now.

Verification:

- Configured repositories sync into SQLite.
- Existing sample mode still works without a token.
- Sync errors are visible and do not break local board state.

### 5. Browser QA For Core Workflows

Run the app locally and test the reviewer workflows in the in-app browser.

Required browser checks:

- Initial inbox load shows populated board columns.
- Quick peek loads when a card is selected.
- Mark caught up updates activity state.
- Add, rename, and delete labels persist after reload.
- Drag card between labels persists after reload.
- Resize a column persists after reload.
- Pin, mute, snooze, and restore remain usable.

## Commit Discipline

Each checkpoint should land as one or more small commits. Do not commit a
half-polished UI step. Every commit should leave the relevant automated checks
passing for the behavior it changes.
