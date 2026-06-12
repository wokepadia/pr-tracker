# AI Insights View Plan

Status: phases 1–2 implemented 2026-06-12 (board-scope contract via
selectBoardScopedItems, the four-section generation in
apps/desktop/src/ai/ai-insights.ts, and the /ai-insights route gated
by AI mode). Phase 3 extras (the cached-notes index, per-section
regeneration, any cadence) remain open questions. Supersedes the
single embedded `AiQueueBriefPanel` on the deterministic Insights
page; that panel graduated into the dedicated page. Grounded in
[ai-insights-research.md](ai-insights-research.md) and
[ai-mode-feature-research.md](ai-mode-feature-research.md); section
admission below cites the relevant findings.

## Concept

The app gets a third top-level view, visible only while AI mode is
active:

- **Inbox** — the queue the user manages.
- **Insights** — deterministic observations (exceptions, deltas,
  contradictions). Stays exactly as shipped, and becomes purely
  deterministic again: the embedded AI brief panel moves out.
- **AI Insights** — a separate page of AI-narrated sections over the
  board. Every sentence restates deterministic facts about board
  items; the AI never re-derives urgency, never ranks the queue, and
  never references a pull request the app cannot link.

The admission rule for an AI section, distilled from the research:

> A section earns its place only if it is **summarization over
> deterministically selected facts** — the one AI insight type with
> quantitative value evidence. Sections that would require the model
> to detect, judge, or score (themes, tone, blockers, risk,
> performance) stay out until accuracy evidence exists.

## Scope contract: board items only

AI insights operate **only on items on the user's board**, never on
the wider set of pull requests the local database happens to know
about. Since 2026-06-12 this contract has two layers, and the first
applies to every surface, not just AI (see CLAUDE.md, "Board Scope
Contract"): the applied **board filter** (the GitHub review query on
the inbox) defines the universe every projection reads — all
surfaces consume the inbox through the shared `useBoardInbox` hook,
keyed on the filter owned by `use-board-filter.ts`. On top of that
filtered universe, the AI input universe is:

1. Pull requests with a **non-archived `board_items` row** on the
   default board, as projected into the inbox view — active items in
   the bucket lanes plus snoozed/muted items (those are still
   user-managed board state).
2. For the catch-up section only: recently merged/closed pull
   requests that **still hold a non-archived board row** (the same
   rule the deterministic while-you-were-away section already uses).

Excluded categorically: pull requests present in `pull_requests`
without a live board row, archived board rows, and anything fetched
ad hoc (a PR opened by URL, a known-PR refresh that outlived the
queue scope). Today sync auto-creates a board row for every synced
PR (`ensureDefaultBoardItem` in
apps/desktop/src/desktop/tauri-data.ts), so the two sets coincide —
but only incidentally. This plan makes board membership the
contract, so future sync broadening (wider search queries, viewing
arbitrary PRs) can never leak into AI input.

Implementation: one shared selector (e.g.
`selectBoardScopedItems(inboxView, boardState)` in the reviewer view
layer) used by both the AI input builder and the page, with unit
tests asserting that non-board and archived items are dropped before
prompt construction. The existing grounding normalizer
(`normalizeQueueBriefContent`) stays as the output-side guard.

## Section catalog

One generation fills sections A–D (single LLM call, single cache
row — the research's minimize-surfaces/cost rule). Each section
renders separately with its own title, empty line, and evidence-
linked rows. The deterministic map stage, ~40-item cap with
edge-keeping, and deterministic ordering (needs-you first,
might-be-missing last) carry over from the current brief unchanged.

### Section A — Board headline

One to three sentences: the single most useful takeaway about the
board right now. Direct carry-over of the brief headline.

### Section B — What needs you, in reading order

Ordered list (max 8) over the deterministic needs-you-now and
might-be-missing rows: each entry is a board PR plus one concrete
"why" sentence drawn from its chips and waiting facts. This is the
existing `needsYou` slot, unchanged in spirit — narrate and group
the chips into a reading plan, never reorder by AI judgment
(deterministic facts stay authoritative; the model only sequences
its prose over them).

### Section C — While you were away

Notes (max 6) over unseen activity and merged/closed-without-you
board items: what concluded or changed without the reviewer.
Existing `whileAway` slot, now anchored explicitly to the shared
insights visit anchor (`visitInsights`); the AI page reuses that
anchor rather than introducing a second away-window.

### Section D — Worth a sweep (new)

Short notes (max 4) over the deterministic hygiene rows (stalled,
review ping-pong). The current brief already feeds these facts to
the model but gives it no output slot, so they can only surface in
the headline. The new slot lets the model group them ("three of the
four stalled PRs are in repo X; the oldest has waited 11 days") —
restating and grouping facts only, no advice about code or people.

### Section E — Recent AI notes on board PRs (display-only, optional)

A list of already-cached per-PR AI artifacts (`ai_summaries` rows:
PR summaries, since-you-looked digests, thread-state summaries) for
current board items, with model/generated-at/stale markers, linking
to the PR detail page. No generation happens from this section; it
is an index of content the user already paid for. Zero marginal
cost, but also no direct research precedent — ships last and only
if it earns its place.

### Explicitly excluded (research-refuted or unevidenced)

- Cross-PR theme detection, tone/blocker detection,
  objection-resolution detection — no verified accuracy evidence;
  highest hallucination risk.
- Risk scores, AI review findings, draft replies — 22% hallucination
  rate in production analogues; trust-destroying.
- Personal productivity narration — the metrics backlash applies to
  prose just as much as to numbers; the AI never grades the
  reviewer.
- Scheduled auto-generation or auto-refresh — workslop evidence;
  every generation stays a button press. If a cadence is ever added,
  follow Linear Pulse (user-chosen, deterministic scope), not
  always-on narrative.
- Per-row AI chips on the inbox — the inbox stays fully
  deterministic.

## Generation architecture

- **Input**: `buildAiInsightsInput(insights, boardScopedItems)` —
  the renamed/extended queue-brief builder, now fed exclusively
  through the board-scope selector. Structured per-item records
  (repo#, title, waiting-on/age, section-labeled chips, up to 5
  unseen-event lines), explicit omitted-count line, no raw
  timestamps in the prompt.
- **Output schema**: extend the brief schema to
  `{ headline, readingOrder (max 8), whileAway (max 6), sweep
  (max 4) }`, every entry `{ pullRequestId, text }`. The normalizer
  drops ids not in the input and dedupes, exactly as today.
- **One call, one cache row**: kind `ai-insights`, sentinel pull
  request id `queue`, cache key = hash of kind + model + user
  prompt. Queue changes flip the stale chip; cached content keeps
  rendering until the user regenerates. A small migration deletes
  the old `insights-brief` rows (content shape changes; cheap to
  regenerate).
- **Failure**: provider errors degrade to the empty/generate state
  with a retry affordance; the deterministic Insights page is never
  affected.

## Page design

- **Navigation**: "AI Insights" appears in the app frame top bar
  (Inbox · Insights · AI Insights · Settings) **only when AI mode is
  active** — key present and toggle on. With AI off the app is
  byte-for-byte unchanged (hard requirement from the feature
  research): no route entry, no layout shift.
- **Header**: page title, AI-generated disclaimer, model +
  generated-at + stale chip, and the single Generate/Refresh button.
  Below it a deterministic input-preview line so the scope is
  legible before anything is sent: "Built from 14 board items · 6
  flagged · 9 with unseen activity", plus the existing privacy hint
  (titles, flags, and unseen activity go to the provider — never
  diffs or comment bodies).
- **Sections**: A as prose; B–D as dense rows reusing the insight
  row anatomy (avatar, repo#, title from local data, AI sentence as
  the why-line, click-through to PR detail, Open-in-GitHub on
  hover). Titles and links always render from local data; AI text is
  only ever the annotation.
- **Empty states**: before first generation, a single explanation
  card (what will be generated, from what scope) with the Generate
  button. After generation, per-section single-line empties ("The
  model had nothing to flag here"). When the board has no flagged
  items at all, the page says so and disables Generate (mirrors the
  current "no insights to brief" guard).
- **Insights page change**: remove the embedded `AiQueueBriefPanel`;
  when AI mode is active, show one quiet link row pointing to AI
  Insights instead.

## Data gaps and refactors to close

1. The shared board-scope selector + tests (view layer; no schema
   change — `board_items.archived_at` already exists).
2. Rename/extend the queue-brief module to the AI-insights module:
   new schema slot for sweep, renamed kinds, prompt addition for the
   sweep instructions.
3. `ai_summaries` migration dropping `insights-brief` rows.
4. AI-mode-gated nav entry and route (`/ai-insights`), following the
   existing `isAiModeActive` gating used by the panel today.

## Suggested implementation phases

1. **Phase 1 — scope contract**: board-scope selector, route the
   existing brief input through it, exclusion tests. No visible UI
   change; the current panel immediately honors the contract.
2. **Phase 2 — the page**: extended schema/prompt/normalizer + cache
   kind migration, new route and page with sections A–D, nav gating,
   panel removed from the Insights page.
3. **Phase 3 — evaluate extras**: display-only Section E; measure
   real token cost per generation at actual board sizes (open
   question carried from the research); only then consider
   per-section regeneration or an opt-in cadence.

## Open questions

- Does the sweep section earn its place, or do hygiene facts belong
  in the headline only? Decide after using Phase 2 for a week.
- Token cost per generation at real board sizes — measure in
  Phase 2 (carried over from the research doc).
- Whether Section E's index of cached per-PR notes is useful or
  clutter — Phase 3 call.
