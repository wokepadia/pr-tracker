# Change Brief: "Stalled on you" Section + Section Info Buttons

Status: proposed 2026-06-12. Amends
[ai-insights-dashboard-spec.md](ai-insights-dashboard-spec.md) and
the section catalog in
[insights-dashboard-plan.md](insights-dashboard-plan.md).

## Problem

On the shipped AI insights dashboard, items whose deterministic
why-chip reads "stalled by you, {actor} spoke last" render inside
**Worth a sweep**, mixed with author-stalled items and review
ping-pong. That section is framed as low-urgency hygiene ("worth a
sweep when you have a minute"), but an item stalled *by the viewer*
is the viewer's own debt — the other side is waiting on them. It
deserves its own, more prominent section instead of being buried
with general aging.

Root cause: the deterministic projection
(`buildReviewerInsights` in
apps/desktop/src/reviewer/insights.ts) computes a single `hygiene`
bucket from two triggers — `stalled` (workflowState === "stale",
with blame derived from who spoke last in the conversation) and
`review_ping_pong` (reviewRounds >= 3). That one bucket is the only
input to the AI `sweep` slot, so both blame directions land in the
same card.

Secondary problem: no section on the dashboard explains what feeds
it. Users can't tell what the AI "looks for" in a section, or that
the selection is deterministic and the AI only writes the prose.

## Product change

### 1. New section: "Stalled on you"

A new dashboard section that owns items where **the viewer is the
blocker on an aged item**:

- Deterministic trigger: `workflowState === "stale"` AND the last
  conversation event (comment or review) was authored by someone
  other than the viewer — i.e. the current "stalled by you" branch
  of the `stalled()` insight.
- "Worth a sweep" keeps the rest: author-stalled items,
  no-conversation stalls, and review ping-pong.
- Long-**overdue reviews stay where they are**: they are claimed
  by "needs you now" (insight #1) and surface in "What needs you,
  in reading order". The new section is for the quieter failure
  mode — items that never tripped the overdue threshold (or whose
  turn-tracking says it is not formally your turn) but where the
  conversation record shows you owe the next reply. The info copy
  (below) states this division explicitly so the two sections
  don't read as overlapping.

Claim order (each PR appears in exactly one section, highest
wins): needs-you-now → might-be-missing → **stalled-on-you** →
while-away → hygiene. So an item that is both overdue and stalled
still shows as overdue; only non-urgent viewer-blame stalls reach
the new section.

Placement on the dashboard grid: in the **left main column**,
between "What needs you, in reading order" and "While you were
away" — it is an action list, so it belongs with the action
panels, not in the bottom hygiene row. The bottom row keeps its
three cards (Worth a sweep · Discussion hotspots · Authors waiting
on you).

The deterministic **Insights page gets the same section** (the
projection is shared), titled "Stalled on you", placed between
"You might be missing this" and "While you were away". Row copy
keeps the existing chip text minus the redundant blame phrase,
e.g. "No activity for 9d — maya spoke last".

AI treatment: a new output slot (`stalledOnYou`, max 4 entries,
same `{ pullRequestId, note }` shape) so the model can group these
items ("both stalls are replies you owe maya in repo X"), exactly
parallel to the sweep slot. Pre-generation, the card renders the
deterministic rows without AI prose, like the other AI panels.

### 2. Info button on AI section headers

Every AI-narrated card on the dashboard (What needs you · Stalled
on you · While you were away · Worth a sweep) gets a small "i"
icon in its header that opens a tooltip explaining (a) which
deterministic facts admit an item into the section and (b) what
the AI does with them. Copy per section, two sentences each, e.g.
for the new section:

> Shows open PRs with no activity past your stall threshold where
> someone else spoke last — meaning the next reply is yours.
> Items already overdue for review appear under "What needs you"
> instead. The AI only groups and restates these facts; it never
> picks the items.

Write equivalent copy for the other three sections from their
trigger definitions (overdue/returned/stale-approval for reading
order; away-window activity and concluded-without-you for
while-away; author-stalled and ping-pong for sweep). Keep the
"selection is deterministic, AI writes the prose" sentence in all
four.

## High-level code direction

1. **Projection split**
   (apps/desktop/src/reviewer/insights.ts): split the `stalled()`
   insight by blame. Add a new insight kind (e.g.
   `stalled_on_you`) and a new section array (e.g. `stalledOnYou`)
   on `ReviewerInsightsView`. The existing `stalled` kind keeps the
   author-stalled and no-conversation branches. Update the `claim`
   ordering as above. Update/extend the projection unit tests:
   blame split, claim precedence (overdue beats stalled-on-you),
   and that hygiene no longer contains viewer-blame stalls.

2. **AI pipeline** (apps/desktop/src/ai/ai-insights.ts): add the
   `stalledOnYou` slot to `AiInsightsContent`, the JSON schema, the
   prompt instructions (mirror the sweep wording: "group, restate
   facts only, no advice"), the chip section-label map (new label,
   e.g. "stalled on you"), and `normalizeAiInsightsContent`
   (grounding, dedupe, cap 4). The prompt/schema change naturally
   changes the cache key, so stale cached `ai-insights` rows
   regenerate on demand; verify no migration is needed.

3. **Dashboard page**
   (apps/desktop/src/pages/AiInsightsPage.tsx): new
   `DashboardCard` + `AiInsightSection` in the left column between
   reading order and while-away, with the same pre-generation
   deterministic placeholder behavior as the existing AI panels.

4. **Deterministic Insights page**: render the new section from
   the shared projection in the position noted above, reusing the
   existing row anatomy and the 5-row/"Show all" cap.

5. **Info buttons**: a tiny header InfoTip built on the existing
   tooltip component
   (apps/desktop/src/components/ui/tooltip.tsx), added to
   `DashboardCard` as an optional `info` prop; copy strings live
   with the page. Apply to the four AI cards on the dashboard.
   (Deterministic-widget info buttons are out of scope; add later
   only if asked.)

6. **Docs**: update the section catalogs in
   ai-insights-dashboard-spec.md (zone list) and
   insights-dashboard-plan.md (insight table) in the same change.

## Out of scope

- Moving overdue reviews out of "needs you now" (explicitly
  decided against above; revisit only if the user asks).
- Info buttons on deterministic widgets (KPI tiles, charts).
- Any new AI judgment: the model still never selects, ranks, or
  scores — the new slot is summarization over a deterministic
  bucket, same as sweep.
