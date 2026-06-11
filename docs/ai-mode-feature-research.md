# AI Mode Feature Research (2026-06-11)

Deep research into which AI features the app should ship at each
UI surface, given the settled architecture: OpenRouter via the
user's own key, one OpenAI-compatible client, structured JSON
output. Claims below were extracted from shipping-tool docs,
academic studies, and practitioner reports, and adversarially
verified against primary sources (23 confirmed, 2 refuted).

## Hard requirements (product constraints, not research)

- AI mode is strictly additive and invisible by default. AI
  features appear ONLY when the user has supplied an OpenRouter
  key AND enabled the AI mode toggle. With either missing, the
  app must be byte-for-byte unchanged in behavior: no AI UI
  affordances (beyond the settings section itself), no network
  calls to OpenRouter, no layout shifts, no schema-driven
  behavior changes.
- Core ranking/ordering stays deterministic. AI never reorders
  the queue and never feeds the classification engine.
- Single maintainer: features must be small, one-shot, and
  independently shippable.

## What the evidence says

- **Trust is the scarce resource.** 46% of developers actively
  distrust AI tool accuracy vs. 33% who trust it (~3% highly
  trust); 66% cite "almost right, but not quite" output as
  their biggest frustration (Stack Overflow 2025 survey). AI
  output must be labeled, evidence-linked, and never silently
  authoritative over deterministic logic.
- **Noisy AI review content is actively harmful.** In a
  human-annotated dataset from Atlassian's production AI
  reviewer, 22% of generated review comments were hallucinated;
  practitioners report that low-quality AI findings train them
  to stop reading AI output entirely. This argues against
  shipping AI review findings, bug-spotting, risk scores, or
  draft comments.
- **PR summarization has the strongest value record of any
  candidate feature.** In a large-scale study (18k treatment vs.
  54k control PRs), Copilot-for-PRs summaries were associated
  with ~1.57x merge likelihood and ~19h less review time; the
  plain change summary was the most-used capability, ahead of
  the code walkthrough. (Observational, 2023 beta population —
  direction is solid, effect sizes may not transfer.)
- **Summaries help most exactly in the catch-up case.** A field
  experiment (N=10, one company — suggestive only) found upfront
  summaries most valued for large PRs, unfamiliar code, and
  newcomers, while reviewers who knew the code preferred
  on-demand interaction. Summaries should be user-triggered per
  PR, not forced on every PR.
- **Manual-trigger is the shipping precedent that works.**
  GitHub Copilot PR summaries are generated only on explicit
  request, never auto-refresh, output a fixed structure (prose
  overview + bulleted key changes linked to code), and carry an
  inaccuracy disclaimer. CodeRabbit is the counterexample: it
  auto-reviews every PR and re-reviews every push — a recurring
  cost/noise profile to reject — though its explicit
  incremental-review command ("review only what changed since
  last review") is the right scoping idea.
- **"Since last visit" is so valuable it ships without AI.**
  Azure Repos has a deterministic "What's new" filter (comments/
  updates since the reviewer last opened the PR) and
  since-last-review diff scoping, no AI involved. The
  deterministic delta is core functionality; an AI digest is an
  optional narrative layer on top — which also keeps AI input
  small and cheap.
- **OpenRouter caching cannot replace app-side persistence.**
  Response caching is opt-in with a 5-minute default TTL (24h
  max) and exact-request matching; provider prompt caching TTLs
  are ~5 minutes (1h max on Anthropic). Useful only for
  within-session Q&A with a stable prompt prefix (diff first,
  questions appended). Generated summaries must be persisted by
  the app in SQLite, keyed by content hash / head SHA.

## Per-surface catalog

### Inbox / queue page

| Feature | Verdict |
| --- | --- |
| Per-row AI summaries or chips | **Avoid.** Cost multiplies by queue size; the inbox stays fully deterministic. |
| AI-suggested review order / time estimates | **Avoid.** Contaminates deterministic ranking; lowest-trust category. |

No AI on this surface in v1. The existing deterministic chips
already carry the triage signal; AI lives one click away on the
PR detail page.

### Pull-request detail page

| Feature | What it does | Evidence | Cost profile | Tier |
| --- | --- | --- | --- | --- |
| "Summarize this PR" button | One-shot structured summary: prose overview + bulleted key changes with file references, over on-demand-fetched diff + cached metadata | Strongest evidence base of any feature (merge-rate study; Copilot precedent) | One generation per head SHA, persisted; diff fetch 5-50KB | **Ship first** |
| "Since you last looked" digest (catch-up flow) | AI narrative over the app's deterministic delta: new commits, comments, review decisions, CI changes since the caught-up marker | CodeRabbit incremental review + Azure "What's new" precedent | Cheapest input (delta only), cached per (last-seen-event, head SHA) | **Ship first** |
| Thread-state summary | "Who owes what / what is contested / what got resolved" over locally cached comment bodies + resolved states | Weakest direct precedent of the three (justified by analogy to summary evidence + existing deterministic attribution) | No diff fetch; one-shot over cached text | **Ship first** |
| Q&A over the diff | Session-scoped chat grounded in the fetched diff | Copilot/CodeRabbit chat precedent; fits prompt caching (diff-first prefix) | Recurring within session; provider cache helps ~5min windows | **Later** |
| Risk-of-change explanation | "Is this risky" tied to evidence (paths, churn, CI history) | No surviving evidence on user trust in risk labels; open question | One-shot | **Later, maybe never** |
| AI review findings / draft replies | Bug-spotting, suggested comments | 22% hallucination rate in production; noise trains users to ignore output; app is read-only anyway | — | **Avoid** |

### Insights page

**No AI in v1.** The chips are deterministic aggregates, and no
surveyed tool shows precedent for LLM-generated dashboard
content. Revisit only if a concrete need appears.

### Settings page

The only surface that changes when AI mode is off — it hosts the
way in:

- OpenRouter API key field (stored in Stronghold next to the
  GitHub PAT, never in SQLite).
- Master "Enable AI mode" toggle (off by default; key alone
  does not enable anything).
- Model picker (sensible default model, user-overridable).
- Optional zero-data-retention routing toggle (OpenRouter `zdr`
  parameter).
- A plain-language cost note: features are user-triggered and
  cached, each generation bills the user's OpenRouter account.

### Onboarding

AI is entirely absent. No mention, no upsell step. Users
discover AI mode in settings.

## Cross-cutting implementation rules

- **User-triggered only.** Every generation is a button press.
  No auto-generation on sync, open, or push (the CodeRabbit
  anti-pattern). A possible later refinement: an opt-in
  "generate eagerly for large/unfamiliar PRs" preference,
  supported by the field-experiment evidence.
- **Cache in SQLite, keyed by content.** Summary: head SHA.
  Digest: (caught-up marker, head SHA). Thread summary: hash of
  thread content. Regenerate only when the key changes; show
  the cached result instantly otherwise.
- **Fixed, labeled output slots.** AI content renders in a
  clearly labeled "AI-generated — may be inaccurate" container
  that occupies space only in AI mode; no layout shift when AI
  is off (Copilot + web.dev guidance).
- **Evidence-linked output.** Structured JSON schema responses
  that reference file paths / comment authors the UI can render
  as links; never free prose making unverifiable claims.
- **Graceful failure.** Provider errors, quota exhaustion, and
  schema-validation failures degrade to the deterministic UI
  with a retry affordance — never block the core flow.

## Recommended v1 AI feature set

1. PR detail: **"Summarize this PR"** (once per head SHA).
2. PR detail catch-up: **"Since you last looked" digest** over
   the deterministic delta.
3. PR detail threads: **thread-state summary** (who owes what /
   what's contested).

Plus the settings surface that gates them. Q&A over the diff is
the natural fourth feature once these prove out.

## Open questions

- Actual per-generation cost on OpenRouter with specific current
  models for 5-50KB diff + threads — no priced claims survived
  verification; measure during implementation.
- Hallucination rate of summaries over locally cached structured
  data (events, comments) vs. raw diffs — bears on whether the
  digest is safer than the diff summary.
- Whether evidence-linked risk explanations can avoid the
  "almost right" distrust pattern — unanswered; reason to keep
  risk labeling out of v1.
- Note: two refuted claims should not be cited — the
  intervention-type percentages for how developers edit AI PR
  descriptions, and the HalluJudge cheap-guardrail figures.

## Key sources

- Stack Overflow 2025 AI survey (trust/frustration figures):
  https://survey.stackoverflow.co/2025/ai
- Copilot-for-PRs merge-rate/review-time study (FSE 2024):
  https://dl.acm.org/doi/10.1145/3643773
- WirelessCar upfront-vs-on-demand field experiment:
  https://arxiv.org/html/2505.16339v1
- Atlassian RovoDev hallucination dataset:
  https://arxiv.org/pdf/2601.19072
- GitHub Copilot PR summaries (responsible use):
  https://docs.github.com/en/copilot/responsible-use/pull-request-summaries
- CodeRabbit commands / auto-review defaults:
  https://docs.coderabbit.ai/guides/commands
- Azure Repos "What's new" since-last-visit filter:
  https://learn.microsoft.com/en-us/azure/devops/repos/git/review-pull-requests?view=azure-devops
- OpenRouter response caching / prompt caching:
  https://openrouter.ai/docs/guides/features/response-caching
  https://openrouter.ai/docs/guides/best-practices/prompt-caching
- web.dev AI UX patterns (user-triggered, accept/edit):
  https://web.dev/learn/ai/ux-patterns

Coverage gaps to keep in mind: no verified claims survived for
Graphite/Diamond, Greptile, Qodo PR-Agent, Cursor BugBot,
Sourcegraph, Linear AI, or Superhuman-style triage patterns, so
the catalog leans on Copilot, CodeRabbit, Azure Repos, and the
academic studies. Thread-state summarization has no direct
shipped-product precedent — it is the most speculative of the
three ship-first features.
