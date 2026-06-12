# Sync Redesign Proposal

Status: core local-first pieces implemented. The app now persists filtered
board membership, renders filtered inbox reads from local SQLite, persists
filter-scope freshness across restarts, refreshes the applied board scope, and
keeps the previous board active while a new filter is being applied. The
two-tier membership/enrichment sync and determinate first-run progress remain
future implementation work. This document records the original diagnosis and
target behavior in detail.

---

## Part 1 — Current state: every surface that syncs, and when

### 1.1 The two sync paths

The app has two distinct sync paths that behave very differently:

**Path A — background controller sync (default scope).** A single
controller mounted in the app frame fires a sync: once at app launch, on
every window focus, on every visibility change back to visible, and on a
fixed 5-minute timer (`apps/desktop/src/app/use-github-sync.ts:42-48`).
These syncs target the *default* scope (the configured repositories,
no search query). They are gated by a 5-minute freshness window and a
60-second failure cooldown, deduplicated when concurrent, and the
default-scope success timestamp is persisted so it survives restarts and
is shared across open windows
(`apps/desktop/src/desktop/tauri-data.ts:1094-1128`).

**Path B — blocking sync-before-read (search scope).** When the board
filter (the GitHub review query that defines the user's responsibility)
is applied, the inbox *read itself* awaits a full GitHub sync before
returning any rows (`apps/desktop/src/desktop/tauri-data.ts:266-268`).
Two properties make this the dominant pain:

- Search-scoped sync successes are **never persisted across restarts**
  and the persisted-freshness check explicitly skips search scopes
  (`tauri-data.ts:1106`, `tauri-data.ts:1185`). Freshness for a search
  scope lives only in an in-memory map, which is empty on every launch.
- The board filter itself **is** persisted (localStorage,
  `apps/desktop/src/app/use-board-filter.ts:15-27`), so a returning user
  always starts the app in search-scope mode.

The combination: every app launch with a filter applied performs a
full, blocking GitHub round trip before the inbox can render anything.

### 1.2 Complete trigger inventory

| Trigger | Path | Gated by freshness? | Blocks UI? |
|---|---|---|---|
| App launch | A (default scope) | Yes (5 min, persisted) | No |
| Window focus | A | Yes | No |
| Visibility → visible | A | Yes | No |
| 5-minute interval | A | Yes | No |
| Manual "Sync now" | A, forced | No | No (button spinner) |
| GitHub settings save | Clears freshness caches; next trigger syncs | — | No |
| Inbox read with board filter | B (search scope) | Session-memory only — effectively **no** on launch | **Yes** |
| Board filter apply/change | B | No | **Yes** |
| Insights visit | None (records a timestamp anchor only) | — | Indirectly (depends on inbox) |
| PR detail open | None (local read only) | — | Brief blank while local read resolves |

### 1.3 What a sync does

Every sync is monolithic. In one run it: lists open PRs per configured
repository plus recently closed ones (or runs the search query), fetches
a full snapshot per PR (reviews, review threads, issue comments, status
checks), reconciles known-open PRs that left the list, ingests
everything in one transaction, and only then reports success. The UI
invalidates and refetches its queries only after the *entire* run
completes (`use-github-sync.ts:19-28`). There is no notion of "the list
is ready, enrichment is still coming."

Notably, with a board filter applied the user pays for **two full
syncs** around launch: the background controller's default-scope sync
(different fingerprint, so not deduplicated against the search-scoped
one) and the blocking search-scoped sync the inbox read triggers. The
default-scope sync's results aren't even what the board renders.

### 1.4 What the user sees today

- **Launch with a filter applied (the normal case):** blank
  `aria-busy` screen (`InboxPage.tsx:681-683`) for the full duration of
  a blocking network sync — even though the local database already
  contains every PR on the board from the previous session. This is the
  "empty screen waiting for sync" experience.
- **Launch on true first run:** blank screen, then a "Setting up your
  review inbox" spinner screen with no progress information.
- **Search sync fails on launch:** error panel with zero rows, despite
  complete local data existing for the board.
- **After data is on screen:** behavior is good — `keepPreviousData`
  keeps rows visible, background syncs are invisible, a banner appears
  on sync errors with a "showing local data" note.
- **Insights and nav badges:** derive from the inbox query, so they are
  empty/undefined for exactly as long as the inbox is blocked.
- **PR detail overlay:** no placeholder data; shows a blank busy state
  while the (fast, local) detail read resolves. Detail content is never
  refreshed while open except via whole-inbox invalidation after a sync.

### 1.5 Divergence from the documented intent

`docs/sync-and-loading.md` states the design intent as "screens render
local data immediately; sync happens in the background" and "true first
loads show lightweight skeletons, not blank screens." Neither holds on
the dominant path: the filtered inbox read is synchronous with the
network, and first loads show a blank busy div, then a spinner screen.
The documented intent is right; the search-scope path violates it.

---

## Part 2 — Diagnosis

The user-visible problems reduce to four root causes:

1. **Reads are coupled to sync.** The filtered inbox read performs a
   network sync inline. Any UI that must wait for a read therefore waits
   for GitHub. This single coupling produces the empty launch screen,
   the blocked insights page, the empty badges, and the
   error-instead-of-data failure mode.

2. **Board membership is not remembered.** The app persists every PR's
   data, but *which PRs are on the board* (the result of the search
   query) is reconstructed from the network on every launch. The most
   important piece of state for rendering the board is the only piece
   that is thrown away.

3. **Sync is all-or-nothing.** One monolithic run fetches membership and
   full per-PR enrichment together, and the UI only learns anything when
   the whole run lands. There is no "rows first, details follow," so
   the cost of any sync is the cost of the slowest part.

4. **Triggers feel random because they are invisible and undifferentiated.**
   Launch, focus, visibility, and timer all fire the same way with no
   user-perceivable rationale, and the search-scope path syncs even when
   nothing suggests data is stale. The user cannot predict when the app
   will hit the network or why.

---

## Part 3 — What comparable apps do (research summary)

Full citations at the end of this section.

- **The local store is the only thing the UI ever waits on.** Linear
  hydrates from a local database and renders in under ~50ms with
  effectively no loading states; the network exists solely to update the
  local store. Superhuman's rule is "the application responds
  immediately; network persistence is asynchronous." Notion tracks a
  per-page "last downloaded" timestamp and refetches only pages whose
  server-side updated time is newer. The universal phrasing of the norm:
  *never show an empty screen if cached data exists* —
  stale-while-revalidate is the modern standard.

- **Sync triggers are standard, but gated by staleness.** The
  battle-tested trigger set is: launch, window focus/visibility, network
  reconnect, a periodic interval, and explicit user refresh — where
  focus/interval triggers only cause network traffic when data is older
  than a staleness threshold. Staleness gating *is* the debounce; no
  ad-hoc timers needed. Comparable GitHub clients: Gitify polls at the
  60-second floor GitHub allows for notifications; Trailer exposes the
  refresh period as a preference and warns the user about API-quota
  pressure rather than degrading silently. A widely-supported refinement
  is refreshing during user *inactivity* so rows aren't yanked from
  under someone mid-triage.

- **GitHub-specific constraints shape the design.**
  - The Search API is the scarcest resource: ~30 requests/minute, no
    conditional-request support, results capped, and eventually
    consistent (a just-updated PR can lag in search results). Best
    practice: use search only to answer "which PRs are in scope," at
    modest cadence — never per-row, never as the freshness source.
  - REST conditional requests (ETag / If-Modified-Since) make unchanged
    polls cost **zero** rate limit; this is the single biggest win for a
    polling desktop client.
  - Reliable incremental sync orders PRs by updated time and stops at
    the last-known high-water mark, fetching details only for PRs whose
    updated timestamp advanced — Notion's per-entity pattern applied to
    PRs. (Caveat from community reports: REST's `sort=updated` ordering
    is unreliable across pages; GraphQL ordering is dependable.)
  - On failure: honor `Retry-After`, sleep until quota reset when
    exhausted, exponential backoff with jitter otherwise — and surface
    quota pressure to the user.

- **Loading UX thresholds.** Stale data beats any placeholder.
  Skeletons are for the true-first-run case only and must match the
  final layout. Don't show any indicator for operations under ~300ms
  to 1s (flashes read as glitches). Indeterminate spinners are
  acceptable only for 1–2s; anything longer needs determinate progress
  ("12 of 40 pull requests"). Background syncs should be invisible
  except a single subtle status affordance (Google Drive's
  "syncing → up to date" is the cited model). Offline is a neutral
  state, not an error. Error messages must be actionable.

- **Architecture patterns.** One controller owns all triggers; concurrent
  triggers coalesce. Foreground (user-initiated, visible feedback,
  bypasses gates) is separated from background (scheduled, silent).
  Sync work is tiered: visible data first, enrichment second. Long syncs
  are structured as small individually-committable units so they can be
  cancelled or superseded without losing completed work. Periodic
  intervals carry jitter so multiple windows don't wake simultaneously.

Sources: Linear sync engine (linear.app/now/scaling-the-linear-sync-engine),
Superhuman offline architecture (blog.superhuman.com/architecting-a-web-app-to-just-work-offline-part-1),
Notion offline (notion.com/blog/how-we-made-notion-available-offline),
Slack Flannel & lazy loading (slack.engineering),
TanStack Query defaults (tanstack.com/query — important-defaults,
window-focus-refetching),
GitHub REST best practices & rate limits (docs.github.com/en/rest/using-the-rest-api),
GitHub notifications polling API (docs.github.com/en/rest/activity/notifications),
`sort=updated` caveat (github.com/orgs/community/discussions/192025),
Jamie Magee on GitHub rate limits (jamiemagee.co.uk/blog/making-the-most-of-github-rate-limits),
Gitify inactivity-refresh proposal (github.com/gitify-app/gitify/issues/1437),
Trailer (github.com/ptsochantaris/trailer),
Google offline/sync design guidelines (developers.google.com/open-health-stack/design/offline-sync-guideline),
loading-feedback UX patterns (pencilandpaper.io/articles/ux-pattern-analysis-loading-feedback),
PowerSync determinate initial-sync progress (releases.powersync.com).

---

## Part 4 — Proposed behavior

### 4.0 The two governing rules

**Rule 1 — No sync ever creates an empty screen.** If the local
database holds anything renderable for a surface, that surface renders
it immediately, always, regardless of any sync's state. A sync may only
*add to* or *update* what is on screen. The only screen allowed to wait
on the network is the true first run, when the database is genuinely
empty — and that screen shows determinate progress, not a blank.

**Rule 2 — The system syncs only with a reason, and the reason is
legible.** Every automatic sync is justified by a staleness check the
user could predict ("I haven't refreshed in N minutes and you just came
back to the window"). No trigger fires when data is fresh. The user can
always see when data was last refreshed and force a refresh manually.

Everything below is these two rules applied surface by surface.

### 4.1 Board membership becomes durable

The set of PRs currently on the board — the result of the applied
filter query — is remembered locally, exactly like the PR data itself.
It survives restarts. "Which PRs am I responsible for, as of the last
successful refresh" is local state; the network's job is to *revise* it,
never to *reconstitute* it.

Consequences:

- Launching the app with a filter applied renders the full board from
  the previous session instantly — rows, lanes, badges, ordering —
  before any network activity begins.
- The membership carries its own "as of" timestamp, shown in the sync
  status affordance, so stale membership is visible rather than silent.
- A PR that left the filter since last session disappears only when a
  membership refresh confirms it left — it never vanishes because the
  app forgot, and it never lingers as a ghost after a refresh says it's
  gone.
- The board-scope contract is unchanged: every surface still derives its
  universe from the filtered board. The only change is that "the
  filtered board" has a durable answer between refreshes.

### 4.2 Reads never touch the network

Every read — inbox, detail, insights, badges, AI context — is a pure
local read. The sync-before-read coupling is removed entirely. Applying
or changing the filter does request a refresh (see 4.5), but the read
that renders the screen does not wait for it.

Consequences:

- The inbox renders in the time it takes to read the local database
  (tens of milliseconds), in every scenario except a truly empty DB.
- A sync failure can no longer blank a surface. Failures surface as a
  banner over fully-rendered local data, never as an error page replacing
  it.
- Insights and nav badges populate immediately from local board data and
  revise themselves when a refresh lands.

### 4.3 Sync splits into two tiers

**Tier 1 — membership and row freshness (fast, cheap, frequent).** One
search-query call answering: which PRs are on the board now, and which
of them changed since their stored updated-timestamp. This is the only
use of the search API, run at most once per refresh cycle, respecting
its scarcity. Tier 1 completing is what updates the board's row set,
ordering inputs, and lane assignment.

**Tier 2 — per-PR enrichment (incremental, prioritized).** Full detail
(reviews, threads, comments, checks) is fetched *only* for PRs whose
updated-timestamp advanced past the locally stored value — the
per-entity high-water-mark pattern. Unchanged PRs cost nothing (or, with
conditional requests, literally zero rate limit). Enrichment is
prioritized: PRs needing the user's attention first, then the visible
rest of the board, then everything else. Each PR's enrichment commits
independently, so:

- The board reflects Tier 1 as soon as Tier 1 lands; it never waits for
  Tier 2.
- A row whose enrichment is still pending renders with its known data;
  if any enrichment-derived field is genuinely unknown for a *new* PR,
  that field alone shows a quiet placeholder — the row itself is present
  and clickable.
- Interrupting a refresh (quit, filter change, network loss) loses only
  the not-yet-fetched PRs, never completed work. The next refresh picks
  up where it left off because high-water marks were advanced per PR.

### 4.4 When the system syncs on its own

A single policy, uniformly applied; all automatic triggers are gated by
the same per-scope staleness window and the existing failure cooldown:

- **Launch:** if the board's data is older than the staleness window,
  start a background refresh *after* the board has rendered from local
  data. If it's fresh (e.g., the app was restarted moments after a
  sync), do nothing. The persisted freshness record covers the *applied
  filter scope* — fixing today's gap where search-scope freshness
  evaporates on restart.
- **Window focus / visibility:** refresh only if stale. Returning to a
  window 30 seconds after leaving it does nothing; returning after lunch
  refreshes quietly.
- **Periodic interval while the window is visible:** refresh when the
  staleness window lapses, with a small random jitter so multiple open
  windows don't wake together. While the window is hidden or minimized,
  the interval slows substantially or pauses — background churn for a
  window nobody is looking at is waste.
- **Mid-triage protection:** an automatic refresh that would reorder or
  remove rows defers applying those list mutations briefly while the
  user is actively interacting with the list (typing, hovering through
  rows, an open detail overlay), then applies them when the user pauses.
  In-place field updates (counts, statuses) apply immediately. Rows are
  never yanked out from under an in-progress action.
- **Manual "Sync now":** always allowed, bypasses all gates, and is the
  one trigger with explicit visible feedback from start to finish.
- **Settings save:** invalidates freshness and triggers an immediate
  refresh, as today.

The default-scope background sync of repositories that are not the
applied board scope stops running as a launch/focus companion. The
board scope is what the user sees; it is what gets refreshed. (Whether
any off-board warming is worth keeping at a much lower cadence is an
open question, §5.)

### 4.5 Applying or changing the filter

The one moment where the network is genuinely load-bearing, handled
honestly:

- On apply, the previous board stays fully rendered and interactive,
  with a clear "applying new filter…" state on the filter control and
  the status affordance — not a blanked list.
- When the new membership lands (Tier 1), the board swaps to the new
  row set in one coherent update. Enrichment for newly-added PRs streams
  in behind it per 4.3.
- If the search fails, the previous board remains, with an actionable
  error on the filter control. The user never trades a working board for
  an error page.
- Re-applying the same filter within the staleness window is a no-op
  beyond a quiet revalidation.

### 4.6 First run (genuinely empty database)

The only sanctioned waiting screen, made honest:

- Immediately after credentials and a filter are configured, show a
  determinate setup screen: "Found 38 pull requests — synced 12 of 38,"
  advancing as each PR's enrichment commits.
- Rows become available as they commit; once the board has its first
  renderable rows (Tier 1 plus the highest-priority enrichment), the app
  transitions to the live board with remaining enrichment continuing in
  the background — it does not hold the screen until 38 of 38.
- Failure mid-setup keeps everything already ingested and offers retry;
  retry resumes, not restarts.

### 4.7 Sync status: one affordance, always truthful

A single sparse status element in the header (where the current label
lives) is the only ambient sync UI:

- **Idle and fresh:** "Updated 2m ago" (relative, decision-relevant
  granularity only).
- **Background refresh in flight:** a subtle in-progress hint on the
  same element — no spinners over content, no row shimmer, nothing that
  competes with the data. Refreshes that finish in under ~1 second show
  nothing at all; flashes read as glitches.
- **Manual sync:** the same element plus the button's own feedback, with
  determinate progress if the refresh involves many PRs.
- **Failure:** the existing banner pattern, kept — over rendered data,
  with the cause ("GitHub rate limit, retrying at 14:32" / "network
  unreachable — showing local data from 12:04") and a retry action.
  Offline is styled as a neutral state, not an error.
- **Quota pressure:** if API-quota consumption approaches its budget,
  the status element says so plainly instead of letting refreshes
  silently slow or fail.

### 4.8 Detail overlay

- Opening a PR's detail renders instantly from local data — the row was
  clickable, therefore its data exists. The current blank busy state is
  replaced by immediate render; if the read somehow exceeds the
  no-indicator threshold, a layout-matching skeleton, never a blank.
- For a brand-new PR whose enrichment hasn't landed, the overlay shows
  every known field with quiet placeholders only in the missing sections
  (e.g., conversation), each filling in as enrichment commits.
- An open overlay receives in-place updates when a background refresh
  lands for that PR; it never closes, blanks, or scroll-jumps on
  refresh. Opening a detail may also bump that PR to the front of the
  enrichment priority queue, so the freshest conversation is fetched for
  precisely the PR being read.

### 4.9 Insights and badges

- Insights render immediately from local board data with the same
  "as of" timestamp as the board. No visit-anchor or sync gate blanks
  the page.
- Nav badges always reflect the current local board and revise live when
  refreshes land. A badge is never zero because a sync is pending; at
  worst it is briefly stale, which the status affordance discloses.

### 4.10 Failure and retry behavior

- All failures keep local data on screen (Rule 1 corollary).
- Rate-limit responses are honored exactly: wait the server-instructed
  interval, sleep until quota reset when exhausted, exponential backoff
  with jitter otherwise. Automatic retries are silent until they
  exceed the staleness window, at which point the status affordance
  discloses degraded freshness.
- The existing failure cooldown stays: repeated focus events during an
  outage don't hammer GitHub. Manual sync remains the user's escape
  hatch and always makes a real attempt.

### 4.11 Multi-window behavior

The current cross-window freshness sharing extends to the filter scope:
a refresh completed by one window satisfies the staleness check of
every window with the same filter, and windows pick up newly-landed
data through their normal local reads. Jittered intervals (4.4) keep
windows from waking simultaneously. One refresh per staleness window
across the whole app, no matter how many windows are open.

---

## Part 5 — Open questions

1. **Staleness window size.** Five minutes (current) is defensible for
   a reviewer inbox; comparable tools sit anywhere from 1 minute
   (Gitify's notification floor) to user-configurable (Trailer). Should
   the window be a setting, and should hidden-window cadence be a fixed
   multiple or fully paused?
2. **Off-board warming.** Should the configured-repositories scope still
   be refreshed at a low cadence (e.g., hourly) so filter changes that
   widen scope land faster, or is the filter-apply refresh path (4.5)
   sufficient? The lean answer is to drop it entirely until a real need
   appears.
3. **Change-signal polling.** GitHub's notifications endpoint is
   explicitly optimized for polling (free when nothing changed) and
   could let the app detect "something happened" between staleness
   windows nearly for free. Worth adopting in this redesign, or a later
   enhancement once the two-tier refresh exists?
4. **Mid-triage deferral scope.** How much interaction counts as "active
   triage" for deferring row mutations — any pointer movement over the
   list, or only stronger signals (open overlay, keyboard navigation,
   text input)? Too-eager deferral makes the board feel stale; too-loose
   makes rows jump.
