# AI Insights Dashboard Spec

Status: proposed 2026-06-12. Supersedes the page-design section of
[ai-insights-view-plan.md](ai-insights-view-plan.md) (the four
stacked sections); the generation architecture, scope contract, and
section admission rule from that plan remain authoritative and are
carried over unchanged. Grounded in
[ai-insights-research.md](ai-insights-research.md) and
[ai-mode-feature-research.md](ai-mode-feature-research.md).

## Problem

The shipped AI Insights page renders the same dense-list anatomy as
the deterministic Insights page: a few titled sections of rows with
short sentences. It reads as "Insights, but with AI text" rather
than as a distinct surface. The intended direction is a proper
SaaS-style dashboard: a multi-section layout where different kinds
of information — stat tiles, charts, ranked lists, breakdown
tables, and AI narration — each get their own visual treatment and
screen region.

## Concept

The dashboard is a **deterministic instrument panel with embedded
AI annotation slots**.

- Most widgets are pure local computations over board-scoped data:
  counts, distributions, trends, and breakdowns the store already
  knows. They render instantly, on every visit, with no model call.
- The AI contributes exactly the slots the research admits
  (summarization over deterministically selected facts): the
  headline, the reading-order sentences, the while-away notes, and
  the sweep grouping. These occupy fixed regions of the grid and
  show a Generate affordance until the user asks for them.

This split resolves the core tension: the page becomes rich and
varied like a SaaS dashboard, while the LLM's role stays as narrow
as the research allows. A user who never presses Generate still
gets a useful dashboard; pressing Generate fills in the narrative
layer.

### Design principles

1. **Deterministic numbers, AI prose.** Every number, count, bar,
   and trend on the page is computed locally. The AI never produces
   a figure; it only writes sentences about facts the page already
   shows. (Admission rule from the research, unchanged.)
2. **Board scope everywhere.** Every widget derives its universe
   from `useBoardInbox` + `selectBoardScopedItems` — the same
   contract as today. No widget may read the wider local store.
3. **Useful before Generate.** The dashboard must be worth opening
   with zero generations. AI panels degrade to compact
   generate/empty states; deterministic widgets never wait on the
   model.
4. **One generation, one cache row.** The single-call pipeline,
   schema, normalizer, and `ai-insights` cache kind carry over
   as-is. The dashboard re-houses the four AI slots; it does not
   add model calls in its first phases.
5. **No grading, no teams.** No personal-productivity narration, no
   reviewer leaderboards, no team metrics. Breakdown widgets group
   the user's own queue by factual dimensions (repo, author, age);
   they never score people.
6. **AI off → page gone.** The route and nav entry stay gated on
   `isAiModeActive`, byte-for-byte unchanged when off.

## Layout

Desktop-only, single scrollable page on a 12-column grid, content
max-width ~1280px. Zones top to bottom:

```
┌────────────────────────────────────────────────────────────┐
│ A · Header: title · scope line · model/stale · [Generate]  │
├─────────┬─────────┬─────────┬─────────┬─────────┬──────────┤
│ B1 Needs│ B2 Un-  │ B3 Stale│ B4 Old- │ B5 Fail-│ B6 Done  │
│ review  │ seen    │ apprvls │ est wait│ checks  │ while    │
│         │ activity│         │         │         │ away     │
├─────────┴─────────┴─────────┴─────────┴─────────┴──────────┤
│ C · AI headline banner (1–3 sentences)                     │
├───────────────────────────────────┬────────────────────────┤
│ D1 · What needs you, in reading   │ D3 · Wait-age          │
│      order (AI rows, max 8)       │      distribution      │
│                                   ├────────────────────────┤
│                                   │ D4 · Board composition │
│                                   │      by lane           │
├───────────────────────────────────┼────────────────────────┤
│ D2 · While you were away          │ D5 · Activity trend    │
│      (AI rows, max 6)             │      (14 days)         │
│                                   ├────────────────────────┤
│                                   │ D6 · Repository        │
│                                   │      breakdown         │
├───────────────────┬───────────────┴───┬────────────────────┤
│ E1 · Worth a      │ E2 · Discussion   │ E3 · Authors       │
│      sweep (AI)   │      hotspots     │      waiting on you│
└───────────────────┴───────────────────┴────────────────────┘
```

- **Zone A** spans 12 columns; sticky is unnecessary (short page).
- **Zone B** is six equal stat tiles (2 columns each).
- **Zone C** spans 12 columns.
- **Zone D** splits 8/4: the left column holds the two primary AI
  list panels stacked; the right rail holds four compact
  deterministic widgets stacked. The rail widgets are fixed-height
  cards; the left panels grow with content.
- **Zone E** is three equal cards (4 columns each).

Row anatomy inside list widgets reuses the inbox/insights row
(avatar, repo#, title from local data, one why-line, click-through
to PR detail, Open-in-GitHub on hover) so the eye transfers across
surfaces.

## Widget catalog

### Zone A — header

Carried over from the current page: title, the AI-generated
disclaimer, model + generated-at + stale chip, the single
Generate/Refresh button, and the deterministic input-preview line
("Built from 14 board items · 6 flagged · 9 with unseen activity")
plus the privacy hint. New behavior: the stale chip and Generate
button govern only the AI slots (C, D1, D2, E1); deterministic
widgets are always live and never marked stale.

### Zone B — KPI strip (deterministic)

Six stat tiles. Each shows a primary number, a one-line label, and
an optional secondary line. Tiles with a zero value render the
zero (a calm dashboard is information too); secondary lines hide
when empty. Clicking a tile deep-links as noted.

| # | Tile | Primary value | Secondary line | Click |
|---|------|---------------|----------------|-------|
| B1 | Needs your review | count of `waitingOn === "you"` | "N overdue" when any `waitingUrgency === "overdue"` | scroll to D1 |
| B2 | Unseen activity | count of items with `unseenEventCount > 0` | "N events total" (sum) | Inbox |
| B3 | Stale approvals | count of `approvalStale` | "oldest Xd" (age since the staleness-causing push) | scroll to D1 |
| B4 | Oldest wait | max `waitingAge` among `waitingOn === "you"` | repo# of that PR | that PR's detail |
| B5 | Failing checks | count of items whose checks rollup is failing | "N also waiting on you" (intersection) | scroll to E2/E3 region |
| B6 | Concluded while away | merged/closed since `lastInsightsVisitAt` with a live board row | "N without your review" | scroll to D2 |

Urgency styling: B1's overdue secondary and B4 past the user's
Settings threshold use the existing overdue accent. No other tile
gets color-coded judgment.

### Zone C — AI headline banner (AI slot: `headline`)

The existing 1–3 sentence headline, rendered as a full-width quiet
banner directly under the KPI strip — the narrative caption for
the numbers above it. Before first generation it collapses into
the explainer card (what will be generated, from what scope) with
the Generate button. After generation with nothing notable, the
model's calm headline still renders ("Quiet board; nothing
urgent.").

### Zone D1 — What needs you, in reading order (AI slot: `readingOrder`)

The primary panel. Ordered rows (max 8) with a rank number, the
standard row anatomy, the AI why-sentence as the why-line, and the
deterministic evidence chips under it (the chips remain
authoritative; the sentence is annotation). Empty state after
generation: "The model had nothing to flag here." Pre-generation:
a placeholder listing the deterministic needs-you-now rows without
AI sentences — the facts render, the prose awaits Generate. This
keeps the panel useful before any model call.

### Zone D2 — While you were away (AI slot: `whileAway`)

Same treatment as D1 (max 6 rows), anchored to the shared
`visitInsights` away-window. Pre-generation placeholder: the
deterministic merged/closed-without-you and digest facts as plain
rows. The AI notes layer on after Generate.

### Zone D3 — Wait-age distribution (deterministic chart)

Horizontal bar chart of items where `waitingOn === "you"`, bucketed
by wait age: `<1d`, `1–3d`, `3d–threshold`, `past threshold`
(threshold = the user's Settings urgency threshold, so the chart
speaks the user's own vocabulary). Bars show counts; the
past-threshold bar uses the overdue accent. Clicking a bar opens
the Inbox. Empty state: "Nothing is waiting on you" (positive,
matches Insights-page tone).

Logic: bucket on the same wait-duration fact that produces
`waitingAge`/`waitingUrgency`; no new computation, just a
projection of existing fields.

### Zone D4 — Board composition (deterministic chart)

One horizontal stacked bar (not a donut — better at this size) of
all board items by inbox lane (`laneId`), with a legend of
lane → count. Snoozed/muted render as their own muted segments so
the user sees how much of the board is parked. Clicking a segment
opens the Inbox. This widget is never empty while the board has
items; with an empty board the whole dashboard shows the global
empty state (see below).

### Zone D5 — Activity trend (deterministic chart)

A 14-day area/sparkline of `activity_events` per day across board
PRs (`occurred_at` bucketed by local day), with a subtle vertical
marker at `lastInsightsVisitAt` ("you last checked here"). The
shape answers "is my queue heating up or cooling down" without
grading anyone. Hovering a day shows "12 events · 4 PRs". Empty
state (no events in window): flat axis with "No activity in the
last 14 days".

Scope note: events are read only for PRs holding a live board row
*now* — consistent with the board contract. We accept that PRs
which left the board take their history with them; the chart is a
pulse, not an audit log.

### Zone D6 — Repository breakdown (deterministic table)

Mini-table, one row per repository present on the board, sorted by
needs-you count desc: repo name · items · waiting on you · oldest
wait. Max 6 rows, then a single "+N more repositories" summary
row. Clicking a row opens the Inbox. Hidden entirely when the
board spans a single repository (the table would restate the KPI
strip — zero-information rule).

### Zone E1 — Worth a sweep (AI slot: `sweep`)

The existing hygiene narration (max 4 notes) over deterministic
stalled and ping-pong rows, as a compact card. Pre-generation
placeholder: the deterministic hygiene rows without prose.

### Zone E2 — Discussion hotspots (deterministic list)

Top 5 board PRs by `unresolvedThreadCount` (only items with
count > 0), each row: repo#, title, "N unresolved threads ·
last reply from {login} {age} ago" (from `review_threads`
last-activity fields). Click opens PR detail at the threads view.
Empty state: "No unresolved review threads." No AI involvement —
thread *summaries* remain a per-PR feature on the detail page.

### Zone E3 — Authors waiting on you (deterministic table)

Groups `waitingOn === "you"` items by `authorLogin`: avatar ·
login · count · oldest wait. Sorted by oldest wait desc, max 5
rows. This is a dependency view of the user's own queue ("whose
work is blocked on me"), not a leaderboard: no rates, no
comparisons, no AI commentary. Click opens the Inbox. Hidden when
fewer than 2 distinct authors (would restate B1/B4).

### Zone F — cached AI notes index (deferred)

The display-only index of cached per-PR AI artifacts (Section E of
the view plan) stays a Phase-3 open question. If it ships, it is a
single full-width collapsed strip below Zone E.

## States

- **Pre-generation**: A renders with Generate; B and D3–D6, E2–E3
  render live; C shows the explainer; D1, D2, E1 show their
  deterministic placeholder rows without AI prose.
- **Generated**: AI slots fill; generated-at and model render in A.
- **Stale** (board changed since generation): stale chip in A; AI
  prose stays visible but each AI panel gets a small stale marker;
  deterministic widgets are already current. The normalizer's
  grounding guard means stale prose can still only reference PRs
  that existed at generation time; rows whose PR has left the board
  drop their link affordance and render the title struck quiet.
- **Provider error**: AI panels show the retry affordance; the rest
  of the dashboard is unaffected.
- **Empty board** (filter matches nothing): the whole grid is
  replaced by the single board-empty card, mirroring the Inbox.
  Generate is disabled.

## Generation architecture (unchanged in phases 1–2)

`buildAiInsightsInput`, the prompt, the
`{ headline, readingOrder, whileAway, sweep }` schema, the
normalizer, the 40-item cap, and the single `ai-insights` cache
row are reused exactly. The dashboard is a presentation change:
the four slots move into grid regions, and everything new around
them is deterministic. Any future AI slot (e.g. a per-KPI delta
sentence) must clear the research admission rule first and is out
of scope here.

## Implementation notes

- Charts (D3–D5) are small, fixed, and few: render them as inline
  SVG/CSS bars rather than adding a charting dependency. Revisit
  only if hand-rolling the trend chart proves fiddly; in that case
  prefer one tiny proven package over a kitchen-sink chart lib.
- All widget computations live in a single projection module (e.g.
  `buildAiDashboardStats(items, settings, visitAnchor)`) in the
  workflow/view layer, unit-tested, fed by board-scoped items only
  — same pattern as `buildReviewerInsights`. No widget computes
  inline in components.
- The grid is plain CSS grid; widgets are presentational cards
  consuming the stats projection. Desktop only, no responsive
  breakpoint work.

## Suggested implementation phases

1. **Dashboard shell + deterministic layer**: the grid, Zone B
   tiles, D3–D6, E2–E3, the stats projection module and tests. The
   existing four AI sections temporarily render stacked in the D1/
   D2/E1/C positions unchanged. Reviewable with AI never invoked.
2. **AI panel re-housing**: pre-generation deterministic
   placeholders in D1/D2/E1, the banner treatment for C, stale
   markers per panel, header behavior scoped to AI slots.
3. **Evaluate extras**: Zone F cached-notes strip, per-section
   regeneration, and any new AI slots — each gated on the
   admission rule and real usage, as in the view plan.

## Explicitly excluded

- Any AI-produced number, score, rank, or trend.
- Team metrics, reviewer comparisons, personal-productivity stats
  (the dropped insight #12 stays dropped).
- Auto-generation, auto-refresh, or generation on page load.
- Widgets reading outside the board scope (refresh history,
  off-board PRs in the local store).
- Mobile/responsive layout work.

## Open questions

- Does the activity trend (D5) earn its place, or is it decoration?
  Ship it in Phase 1 and judge against the zero-value-metric rule
  after a week of real use.
- Should B5 (failing checks) instead live as a chip inside D1 rows?
  Decide once real boards show how often checks fail.
- Whether E3 (authors waiting) feels useful or redundant next to
  D1's ordering — same one-week judgment.
