# Insights Dashboard Plan

Status: researched 2026-06-11, not yet implemented.

## Concept

The app gets a second top-level view next to the inbox:

- **Inbox** — the queue the user manages: buckets, pins, snoozes, notes.
- **Insights** — read-only observations the system computed for the user:
  things they might be missing, situations that changed or aged past a
  threshold, and notable updates.

The defining admission rule, distilled from prior art (Gerrit attention
sets, Pull Panda/Pull Reminders, Graphite inbox sections, Octobox):

> An insight earns its place only if it reports an **exception, delta, or
> contradiction** — something that crossed a threshold, changed while the
> user was not looking, or conflicts with the user's own marks. If a row
> merely restates that a PR exists in the queue, it is noise.

Everything is deterministic: computed from local SQLite facts and local
queue state. No LLM, no generated prose, no new GitHub API calls.

## Constraints carried over from existing docs

- Insights is a **projection** over the shared domain model (CLAUDE.md):
  a `buildReviewerInsights(...)` function in the workflow/view layer fed
  by the same classified items the inbox uses. No insight state on core
  entities.
- Reuse the V1 vocabulary the user already knows: turn ownership (F1),
  evidence chips (F2), since-last-review deltas (F3), wait urgency
  thresholds from Settings (F5), review rounds (F6), stale approvals (F9).
- UI audit rules apply: never repeat a fact the row already shows, hide
  zero-value metrics, dense operational lists, no decorative cards.

## The insight catalog

Ordered by section as they appear on the page. Each PR appears in at most
one section (highest section wins).

### Section 1 — Needs you now (exceptions; persist until the state changes)

| # | Insight | Deterministic trigger | Row copy pattern |
|---|---------|----------------------|------------------|
| 1 | Overdue review | `waitingOn === "you" && waitingUrgency === "overdue"` | "Your turn for 4d — past your 72h threshold" |
| 2 | Returned to you | workflow `updated_since_review` or `needs_thread_attention` (author pushed or replied after your review) | "maya pushed 2 commits after your review" / "2 replies waiting in threads you opened" |
| 3 | Stale approval | `approvalStale === true` | "You approved, then 3 commits landed" |

These need no stored dismissal: they disappear when the underlying state
changes (you review, the thread resolves, you re-approve).

### Section 2 — You might be missing this (contradictions with your own marks)

| # | Insight | Deterministic trigger | Row copy pattern |
|---|---------|----------------------|------------------|
| 4 | Snoozed, but it moved on | `snoozed && activity newer than snoozedAt` | "Snoozed 5d ago — 4 events since, incl. re-request" |
| 5 | Muted, but you were re-requested | `muted && review_request event for viewer newer than mutedAt` | "Muted, but review was re-requested yesterday" |
| 6 | Piling up unseen | `unseenEventCount > 0 && lastSeenAt older than 7d` | "8 unseen events; last opened 12d ago" |
| 7 | Parked in a bucket | active bucket (not Done/Later) and no activity events for 7d+ while it is the author's turn | "In Reviewing for 9d with no movement" |

Rows 4–5 are the highest-value novel insights in the catalog: they cross
the user's local marks with remote facts, which no other surface does.

### Section 3 — While you were away (windowed FYI; expire on visit)

| # | Insight | Deterministic trigger | Row copy pattern |
|---|---------|----------------------|------------------|
| 8 | Digest strip | aggregate of `activity_events.occurred_at > lastInsightsVisitAt` (fallback window 7d) | "Since yesterday: 5 PRs updated · 2 merged · 1 new request" |
| 9 | Merged/closed without you | PR you had a board item for (not muted) reached `merged_at`/`closed_at` since last visit, without your approval on record | "Merged Tue without your review — you can drop it" |

Windowed items batch per PR (one row per PR, "4 comments, 1 commit"),
never an event feed. They expire silently once seen; no manual dismissal
needed in the first version.

### Section 4 — Hygiene (weekly cadence, collapsed by default)

| # | Insight | Deterministic trigger | Row copy pattern |
|---|---------|----------------------|------------------|
| 10 | Stalled PRs | open, no events for 7d+, in an active bucket (`workflowState === "stale"`) | "No activity for 11d" |
| 11 | Review ping-pong | `reviewRounds > 2` | "4 changes-requested rounds — consider a call" |
| 12 | Personal pace (optional, last) | counts over trailing 7d: reviews you submitted, median request→review response | "You reviewed 6 PRs this week; median response 4h" |

Row 12 is framed as a private personal stat against the user's own
Settings thresholds (Swarmia "working agreement" framing), not a KPI. It
is the lowest-priority item and can be dropped if it feels like noise.

### Explicitly excluded

- Team metrics, reviewer load balancing, DORA-style analytics (n=1).
- CI/check-run insights ("approved but CI red", "checks went green while
  you waited") — high value but **blocked on F10**: the
  `pull_request_check_runs` table exists and is indexed, but nothing
  ingests check runs yet. Revisit when F10 lands.
- Anything requiring LLM summarization (V1 scope rule).

## Page design

- **Navigation**: "Insights" becomes a sibling of the inbox in the app
  frame's top bar (Inbox · Insights · Settings). It is a separate route,
  not a tab inside the inbox sidebar — the sidebar belongs to the managed
  queue.
- **Layout**: single scrollable column, desktop density:
  1. Digest strip (one line, top) — insight #8.
  2. Four titled sections in the order above. Dense list rows, identical
     row anatomy to inbox rows (repo#, title, why-chip, age) so the eye
     transfers; click opens the PR detail, with quick actions on hover
     (Open in GitHub, Restore from snooze/mute for section 2 rows).
  3. Each row carries exactly one **why-chip** stating its trigger
     ("requested 3d ago", "2 commits after approval") — the GitHub
     notifications "reason" pattern; reuse F2 evidence chips.
- **Noise caps**: max 5 rows visible per section with "Show all (N)";
  target ≤20 visible rows total.
- **Empty states are good news**: per-section single-line confirmations
  ("No reviews waiting on you") and a whole-page "You're all caught up —
  nothing needs your attention" state when every section is empty.
- **Freshness**: the page reuses the inbox sync-status label and the
  background-sync hook; insights recompute from local data on every
  invalidation. Local reads only — the page renders instantly.

## Data gaps to close (small, before or with phase 1)

1. `lastInsightsVisitAt` — one local app_settings key, written when the
   Insights route unmounts (powers sections 3 and the digest window).
2. `snoozedAt` / `mutedAt` timestamps — `board_items.is_snoozed/is_muted`
   are bare booleans today; add nullable timestamp columns set when the
   flag turns on (powers insights #4–5 precisely; `updated_at` is too
   coarse because any board write touches it).
3. A `buildReviewerInsights` projection module (workflow/view layer) with
   unit tests per trigger rule.

## Suggested implementation phases

1. **Phase 1**: route + nav, projection module, sections 1 and 2
   (insights 1–7), empty states. Requires data gaps 1–3.
2. **Phase 2**: digest strip and merged/closed-without-you (8–9).
3. **Phase 3**: hygiene section (10–11), then evaluate whether personal
   pace (12) earns its place.
4. **Later**: CI insights once F10 ingestion exists.
