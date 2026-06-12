# Sync and Loading Behavior

This describes when the desktop app talks to GitHub and what the user
sees while data loads. The goal is local-first rendering: screens always
render local SQLite data immediately, and syncing happens quietly in the
background on a predictable schedule.

## When syncs happen

All background syncs are owned by `useGithubSyncController`, mounted once
in `AppFrame`. Navigating between screens never triggers a sync. The
controller refreshes the applied board scope: when a GitHub review query is
applied, automatic and manual syncs target that filtered scope instead of
warming an unrelated default repository scope.

The controller starts a sync:

- once at app launch,
- when the window regains focus or becomes visible again,
- on a five-minute interval,
- and pages can force one through the manual "Sync now" action.

Saving GitHub settings also kicks a forced sync for the currently applied
board scope so new credentials take effect immediately.

## Local board reads

Inbox, detail, insights, badges, and AI inputs read only from local SQLite.
Applying a board filter does not make the read path touch GitHub. Instead,
successful filtered syncs store durable membership rows for the exact filter
scope, and later reads use those rows to decide which cached pull requests are
on the board.

That membership survives app restarts. Launching with a persisted board filter
therefore renders the last successful filtered board immediately, then the
background controller revalidates the same scope when it is stale.

## Freshness policy (data layer)

`syncBeforeRead` in `tauri-data.ts` is used only by explicit sync triggers. It
decides whether a trigger becomes a real GitHub round trip:

- Successful syncs are remembered per settings fingerprint (credentials
  plus GitHub search query). A trigger inside the five-minute freshness
  window is a no-op.
- Sync success is persisted per scope in `app_settings`, so reopening the
  app shortly after a filtered sync renders local data without re-syncing.
  The persisted success is re-read whenever the in-memory entry goes stale,
  so concurrently open app instances see each other's syncs instead of each
  re-syncing on its own interval.
- Failures are remembered for sixty seconds and re-throw the same error
  instead of retrying, so refocusing the window while GitHub is down
  does not hammer the API. The error banner stays accurate because the
  re-thrown error flows through the same mutation state.
- A forced sync (manual button, settings save) bypasses both gates.
- Concurrent triggers with the same fingerprint share one in-flight
  sync promise.

The sync result reports whether local data actually changed: `"synced"`
(a GitHub sync or sample-data seed landed) versus `"already-fresh"`.
Query invalidation only happens for `"synced"`, so skipped syncs never
churn the UI.

## Database locking (storage layer)

The desktop SQLite file may be shared by several open windows of the
app, so writes are kept rare and short:

- The database runs in WAL mode (set once at startup; it persists in
  the file), so readers never block on a writer. Per-connection
  settings such as `busy_timeout` (5s) and `foreign_keys` come from
  sqlx defaults on every pooled plugin connection; pragmas issued
  through the plugin only reach one pooled connection and are not used
  for per-connection settings.
- Ingestion skips pull requests whose snapshot is byte-identical to
  the stored payload, so a steady-state sync is effectively read-only
  and does not contend for the write lock.
- The shared persisted sync success (above) keeps multiple instances
  from running duplicate syncs in the same freshness window.

## Loading rules (UI layer)

- The query client uses `staleTime: 30s` and `gcTime: 30min`, so screen
  switches reuse cached local reads and render instantly. Local data
  only changes through mutations and syncs, which invalidate their
  queries explicitly.
- Sync state is shared across all `useGithubSync` instances via the
  mutation key, so every header shows the same "syncing" state and last
  synced time.
- Applying a new GitHub review query keeps the previous board rendered while
  the new membership sync runs. If the search fails, the previous board stays
  active and the filter control shows the error.
- True first loads (nothing cached yet) show lightweight skeletons, not
  blank space. Every later visit renders local data immediately while
  any sync runs in the background.
