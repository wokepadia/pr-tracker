# AI Insights Dashboard Spec

Status: implemented 2026-06-12. Supersedes the page-design section of
[ai-insights-view-plan.md](ai-insights-view-plan.md); the generation
architecture, scope contract, and section admission rule from that plan
remain authoritative.

## Concept

The AI Insights page is a deterministic dashboard with embedded AI
annotation slots.

- Deterministic widgets and rows are computed locally from board-scoped
  items. They render on every visit without a model call.
- AI contributes only prose over deterministically selected facts:
  `headline`, `readingOrder`, `stalledOnYou`, `whileAway`, and `sweep`.
- A user who never presses Generate still gets the current dashboard rows;
  generated prose only replaces the row note text inside AI slots.

## Principles

1. **Deterministic facts, AI prose.** Counts, selected rows, ordering, and
   eligibility are local projections. The model never invents a number,
   rank, or item.
2. **Board scope everywhere.** Every input derives from `useBoardInbox`
   and the board-row selector in `apps/desktop/src/reviewer/board-scope.ts`.
   No dashboard widget or AI prompt may read outside the applied board
   filter.
3. **One generation, one cache row.** The single `ai-insights` cache entry
   stores the five AI slots. Adding `stalledOnYou` did not add another
   model call.
4. **No grading, no teams.** Breakdowns group the user's own queue by
   factual dimensions only. There are no reviewer comparisons or personal
   productivity scores.
5. **AI off -> page gone.** The route and nav entry remain gated on
   `isAiModeActive`.

## Layout

Desktop-only, single scrollable page on a 12-column grid, content
max-width around 1280px:

```
┌────────────────────────────────────────────────────────────┐
│ A · Header: title · scope line · model/stale · [Generate]  │
├────────────────────────────────────────────────────────────┤
│ C · AI headline banner                                     │
├───────────────────────────────────┬────────────────────────┤
│ D1 · What needs you               │ D4 · Repository        │
│      (AI rows, max 8)             │      breakdown         │
├───────────────────────────────────┤                        │
│ D2 · Stalled on you               │                        │
│      (AI rows, max 4)             │                        │
├───────────────────────────────────┤                        │
│ D3 · While you were away          │                        │
│      (AI rows, max 6)             │                        │
├───────────────────┬───────────────┴───┬────────────────────┤
│ E1 · Worth a      │ E2 · Discussion   │ E3 · Authors       │
│      sweep (AI)   │      hotspots     │      waiting on you│
└───────────────────┴───────────────────┴────────────────────┘
```

The list-row anatomy reuses the inbox/insights pattern: avatar, repo and
number, title, one why line, PR-detail click-through, and Open-in-GitHub on
hover.

## Widget Catalog

### Zone A - Header

Carried over from the current page: title, AI-generated disclaimer,
generated-at/model state, stale chip, the Generate/Refresh button, and the
deterministic input-preview line ("Built from N board items ..."). The stale
chip and Generate button govern only AI slots; deterministic widgets are
always current.

### Zone C - AI Headline (`headline`)

Full-width quiet banner under the header. Before generation it shows the
explainer and Generate affordance. After generation it renders the cached
headline.

### Zone D1 - What Needs You (`readingOrder`)

Ordered rows for urgent reviewer work: overdue reviews, pull requests
returned after the viewer's review, and stale approvals. Max 8 rows. Before
generation the deterministic `needsYouNow` rows render with their why chips;
after generation the AI `why` sentence is used as the row note. Rows in this
section claim before `stalledOnYou`.

### Zone D2 - Stalled On You (`stalledOnYou`)

Rows for stale open PRs where the last conversation event was by someone
other than the viewer, meaning the next reply is likely the viewer's. Max 4
rows. Long-overdue reviews remain in D1 even when someone else spoke last.
Before generation the deterministic stalled rows render with their why chips;
after generation the AI `note` is used as the row note.

### Zone D3 - While You Were Away (`whileAway`)

Rows anchored to the shared `visitInsights` away window. Max 6 rows. Before
generation the deterministic while-away rows render with their why chips;
after generation the AI `note` is used as the row note.

### Zone D4 - Repository Breakdown

Mini-table, one row per repository present on the board, sorted by
needs-you count descending: repository, item count, waiting-on-you count,
and oldest wait. Max 6 rows, plus a single "+N more repositories" summary.
Hidden when the board spans only one repository.

### Zone E1 - Worth A Sweep (`sweep`)

Compact AI-narrated card over deterministic author-stalled,
no-conversation-stalled, and ping-pong rows. Reply stalls owed by the viewer
belong in D2 instead. Before generation the deterministic hygiene rows
render with their why chips; after generation the AI `note` is used.

### Zone E2 - Discussion Hotspots

Top board PRs with unresolved review threads, each row showing thread count
and last reply author/age. Empty state: "No unresolved review threads."

### Zone E3 - Authors Waiting On You

Groups `waitingOn === "you"` items by author: avatar, login, count, and
oldest wait. Sorted by oldest wait descending, max 5 rows. Hidden when fewer
than two distinct authors would be shown.

## AI Card Info Buttons

AI-narrated dashboard cards include an info button:

- **What needs you** explains urgent reviewer work and that reply stalls
  live under Stalled on you unless already overdue.
- **Stalled on you** explains the stale conversation ownership rule and
  the D1 precedence rule.
- **While you were away** explains the board-scoped away window.
- **Worth a sweep** explains cleanup rows and that viewer-owned reply
  stalls are excluded.

Each tooltip must say that AI only groups or restates deterministic facts;
it never selects the items.

## Projection Architecture

- `buildReviewerInsights` owns section eligibility and claim order:
  `needsYouNow` -> `mightBeMissing` -> `stalledOnYou` -> `whileAway` ->
  `hygiene`.
- `buildAiInsightsInput` consumes that projection and emits the five AI
  section inputs in dashboard order.
- `buildAiDashboardStats` owns deterministic dashboard widgets. It accepts
  board-scoped `ReviewQueueItemView[]` only and has unit tests for hidden
  widget behavior.

## States

- **Pre-generation**: A renders with Generate; D4, E2, and E3 render live;
  C shows the explainer; D1, D2, D3, and E1 show deterministic rows without
  generated prose.
- **Generated**: AI slots fill; generated-at and model render in A.
- **Stale**: stale chip renders in A; cached AI prose stays visible until
  regenerated; deterministic widgets are already current.
- **Provider error**: AI panels show the retry affordance; deterministic
  widgets are unaffected.
- **Empty board**: the grid is replaced by the single board-empty card and
  Generate is disabled.

## Explicitly Excluded

- AI-produced numbers, scores, ranks, trends, or item selection.
- Team metrics, reviewer comparisons, or personal-productivity stats.
- Auto-generation, auto-refresh, or generation on page load.
- Reads outside board scope, including refresh history or off-board PRs in
  the local store.
- Mobile/responsive layout work.
