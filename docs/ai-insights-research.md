# AI Insights Research (2026-06-11)

Deep research into what an AI insights surface should contain for
this app, which insights LLMs genuinely unlock beyond the
deterministic chips, and how to aggregate and present them.
Claims were adversarially verified against primary sources
(21 confirmed, 4 refuted); refuted claims are listed at the end
so they are not reused.

## What the evidence says

- **Queue-level metrics are deterministic everywhere they
  ship.** Cycle time, review turnaround, merge counts (Graphite
  Insights, GitHub) are timestamp math, not LLM output. AI in
  shipping tools is reserved for summarization, scoped by
  deterministic filters.
- **Summarization remains the only AI insight type with
  quantitative value evidence** (Copilot-for-PRs: ~19.3h less
  review time, ~1.57x merge odds in a 68k-PR quasi-experiment).
  Cross-PR theme detection, tone/blocker detection, and
  objection-resolution detection have no verified accuracy
  evidence — defer them.
- **The shipping templates for an AI briefing are GitHub and
  Linear Pulse.** GitHub PR summaries: generated only on manual
  request, never auto-refreshed, prose + evidence-linked
  bullets, framed as a supplement. Linear Pulse: AI digest
  scoped purely by deterministic signals (membership,
  subscription), delivered on a user-chosen cadence — the AI
  never chooses what is relevant.
- **Personal productivity metrics are a trap.** A documented
  backlash (Beck/Orosz response to McKinsey; GitHub researcher:
  tracking feels "anxiety-inducing", "a lot like spying")
  argues against review counts or speed scores, even though
  they are deterministic. Insights should describe the queue's
  state, never grade the reviewer.
- **Unsolicited low-substance AI content erodes trust**
  ("workslop": ~2h of recipient cleanup per incident, 42%
  trust loss toward senders — directional, vendor survey).
  Supports strict gating: opt-in, user-triggered, no scheduled
  auto-generation in v1.
- **Map-reduce aggregation has documented failure modes**: eight
  coherence error types (BooookScore, ICLR 2024), inter-chunk
  dependency/conflict losses, ~4% hallucinated nodes in
  recursive summarization (RAPTOR audit), and upward error
  propagation cannot be ruled out (the claim that it does not
  propagate was refuted 0-3). Mitigations with 3-0 verification:
  structured per-item records (facts + explicit
  nothing-to-report) instead of free prose, and a SHALLOW
  one-level rollup.
- **Positional bias is first-order**: U-shaped faithfulness
  (middle of long inputs neglected; NAACL 2025). Order the
  rollup input deterministically with the most important items
  at the edges, and keep the input small rather than relying on
  long context.

## Deterministic vs. AI split for this app

Stays deterministic (existing chips, untouched): all triggering,
attribution (who owes, for how long), thresholds, ordering,
counts, and the digest strip. AI never re-derives urgency and
never ranks the queue.

AI adds (v1): one **queue brief** — a narrative layer over data
the deterministic layer already computed:

1. **"What needs you and why"** — narrates and groups the
   existing chips into a short reading plan.
2. **"While you were away"** — catch-up notes over unseen
   activity across PRs.

Combined into a single generation/panel to minimize surfaces
and cost. Deferred: merged-changelog digest across repos
(partially covered by deterministic merged-without-you chips),
cross-PR theme detection, tone/blocker detection,
objection-resolution detection (highest hallucination risk, no
accuracy evidence).

## Composition and caching strategy

- **Map stage is deterministic in v1** (no per-PR LLM calls):
  each relevant PR becomes a structured record from local data —
  repo#, title, waiting-on/age/urgency, its deterministic insight
  chips, and up to 5 unseen-event lines (actor + event title).
  PRs included: any PR appearing in an insight section or with
  unseen events; capped (~40).
- **Reduce stage is one LLM call** over those records,
  deterministically ordered with needs-you-now items first and
  might-be-missing last (edges = most faithful), middle for
  hygiene/while-away.
- **Grounding contract**: the model returns only PR ids it was
  given plus short why/note strings; the normalizer drops any id
  not in the input, and the UI renders titles/links from local
  data — AI text can never name a PR the app cannot link.
- **Caching**: one row in ai_summaries (kind `insights-brief`,
  sentinel pull request id `queue`), keyed by a hash of the
  exact rollup input + model. Queue changes flip a stale chip;
  regeneration is always a button press.

## Presentation guidance

- Deterministic chips lead the page and remain the source of
  truth; the AI brief sits as a compact generate-on-demand panel
  under the digest strip (a button row until generated — "behind
  an explicit user action").
- Label as AI-generated with model + generated-at + stale chip,
  same as the PR-page panels.
- Every AI sentence ties to specific PRs via local links
  (GitHub's prose-plus-evidence-linked-bullets template).
- No scheduled auto-refresh in v1. If a cadence is added later,
  follow Linear Pulse (user-chosen daily/weekly, deterministic
  scope), not always-on dashboard narrative — the workslop
  evidence predicts ignored wallpaper.
- No personal productivity metrics anywhere.

## Open questions

- Long-term retention of AI digests (do users keep them on?) —
  no evidence either way; gating keeps the cost of being wrong
  low.
- LLM accuracy for cross-PR theme/tone detection — unproven;
  revisit before ever building those.
- Real token costs per brief at this app's queue sizes — measure
  during implementation.

## Refuted claims (do not reuse)

- "Graphite has no AI narrative anywhere" (1-2).
- Copilot PR-description intervention-type percentages (0-3).
- RAPTOR's 20% QuALITY gain (0-3).
- "Hierarchical hallucinations do not propagate upward" (0-3).

## Key sources

- Copilot-for-PRs value study (FSE 2024): https://arxiv.org/pdf/2402.08967
- GitHub PR summaries responsible use: https://docs.github.com/en/copilot/responsible-use/pull-request-summaries
- Linear Pulse: https://linear.app/changelog/2025-04-16-pulse
- Productivity-metrics backlash: https://newsletter.pragmaticengineer.com/p/measuring-developer-productivity
- Workslop trust evidence: https://hbr.org/2025/09/ai-generated-workslop-is-destroying-productivity
- BooookScore coherence errors: https://arxiv.org/abs/2310.00785
- LLM×MapReduce structured-record mitigations: https://aclanthology.org/2025.acl-long.1341.pdf
- Positional faithfulness (NAACL 2025): https://arxiv.org/abs/2410.23609
- RAPTOR hallucination audit: https://arxiv.org/pdf/2401.18059
- Graphite Insights: https://graphite.com/features/insights
