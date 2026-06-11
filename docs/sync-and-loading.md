# Sync and Loading Behavior

This describes when the desktop app talks to GitHub and what the user
sees while data loads. The goal is local-first rendering: screens always
render local SQLite data immediately, and syncing happens quietly in the
background on a predictable schedule.

## When syncs happen

All background syncs are owned by `useGithubSyncController`, mounted once
in `AppFrame`. Navigating between screens never triggers a sync.

The controller starts a sync:

- once at app launch,
- when the window regains focus or becomes visible again,
- on a five-minute interval,
- and pages can force one through the manual "Sync now" action.

Saving GitHub settings also kicks a forced sync so new credentials take
effect immediately.

## Freshness policy (data layer)

`syncBeforeRead` in `tauri-data.ts` decides whether a trigger becomes a
real GitHub round trip:

- Successful syncs are remembered per settings fingerprint (credentials
  plus GitHub search query). A trigger inside the five-minute freshness
  window is a no-op.
- The default-scope success is persisted in `app_settings`
  (`github-sync-last-success`), so reopening the app shortly after a
  sync renders local data without re-syncing. Search-scoped successes
  stay session-only.
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

## Loading rules (UI layer)

- The query client uses `staleTime: 30s` and `gcTime: 30min`, so screen
  switches reuse cached local reads and render instantly. Local data
  only changes through mutations and syncs, which invalidate their
  queries explicitly.
- Sync state is shared across all `useGithubSync` instances via the
  mutation key, so every header shows the same "syncing" state and last
  synced time.
- True first loads (nothing cached yet) show lightweight skeletons, not
  blank space. Every later visit renders local data immediately while
  any sync runs in the background.
