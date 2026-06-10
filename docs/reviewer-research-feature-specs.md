# Reviewer Research and Derived-Feature Specs

Research date: 2026-06-10.

This document summarizes research into what matters to a person
reviewing pull requests on GitHub, documented pain points with
GitHub's PR review interface, and what deterministic analyses over
existing GitHub data this app can surface better than GitHub does.
Each proposed feature ends with a brief product spec.

Method: multi-source web research (academic studies, competing tool
documentation, GitHub Community discussions, Reddit and Hacker News
threads) with adversarial claim verification. 24 of 25 top claims
survived 3-vote verification; the one refuted claim is noted below.
Reddit quotes are anecdotal community sentiment, not verified
claims, and are labeled as such.

## Part 1: What Reviewers Need

The research consistently splits reviewer needs into two modes that
map directly onto our quick peek and detail views.

### Triage mode (quick peek)

When deciding which PR to spend time on, reviewers run on a small
set of deterministic signals:

- **Whose turn is it?** The single most validated signal. Gerrit
  models review as a turn-based workflow with a per-change
  "attention set" and a "Your turn" dashboard section; Reviewable
  independently ships a rule-based "waiting on" algorithm. Both are
  computed purely from review events — no LLM needed. Google's
  Gerrit design team found that *not* knowing whose turn it is
  causes measurable waste: over-adding reviewers, repeatedly
  polling dashboards, or abandoning dashboards entirely.
- **Criticality and urgency.** A 749-integrator survey (Gousios et
  al., ICSE 2015) found integrators prioritize bug fixes first,
  then by urgency.
- **Size.** Small PRs get processed first ("The lower the number of
  lines/files changes, the more likely I am to process it first").
  Size is also a validated risk signal: useful comments decrease
  and latency increases as change size grows (Sadowski et al.,
  Google, 9M changes).
- **Age / FIFO.** Many integrators prefer oldest-first; 18% report
  having no triage process at all — tooling headroom.

Gerrit's design doc states the two information levels verbatim, and
they match our surfaces exactly: (a) at a glance, which changes
need my attention; (b) per change, *why* attention is or is not
needed.

### Deep-review mode (detail view)

- **Understanding the change — especially its rationale — is the
  dominant need.** Microsoft's ICSE 2013 study: understanding the
  reason for the change is "the biggest information need." A
  card-sort of 900 review threads (Pascarella et al., CSCW 2018)
  found the top categories are suitability of the solution, correct
  understanding, rationale, and code context. These questions are
  answered with a 5–7h median delay on real projects, so surfacing
  the information directly saves real waiting time.
- **Thread resolution is a first-class workflow primitive** in
  best-in-class tools. Google's Critique treats unresolved comments
  as mandatory author action items; over 80% of changes need at
  most one resolution iteration, so a high iteration count is a
  meaningful "stuck" signal. Reviewable models each thread as a
  discussion whose resolution state persists independently of code
  changes — unlike GitHub, where pushing code outdates and hides
  threads.
- **Review tools underserve these needs.** Bacchelli & Bird (2013):
  all tools in practice "deliver only basic support for the
  understanding needs of reviewers"; 2024–2025 follow-up work still
  identifies change understanding as the dominant unmet challenge.
  A derived-data UI on top of GitHub addresses a persistent gap,
  not a solved problem.

## Part 2: GitHub Interface Pain Points

### Verified (survey/academic)

- Integrators explicitly report inefficiencies in GitHub itself:
  the review tool ("a huge step backwards from Reviewboard") and
  notification handling ("Sifting through the GitHub information
  flood to find what, if any, I should address"). 2014-era data,
  but the pain-point categories are corroborated by 2024–2026
  community discussions and by the continued market for
  Reviewable, Graphite, and similar tools.
- Healthy review loops are fast (Google: median full-review latency
  under 4 hours; cross-company medians-to-approval 14–24h), so
  multi-day un-actioned PRs are statistical outliers worth
  flagging. Aging PRs accumulate real or logical merge conflicts.

### Community inventory (Reddit / HN / GitHub Community — anecdotal)

Triage-side:

- Notification noise: "an email for every action… so obnoxious";
  thousands of unread notifications drown out review requests
  (r/ExperiencedDevs, 2021).
- Notifications are opaque — can't tell what they are without
  clicking through and loading the page (r/github, 2024).
- Hard to get a reliable list of PRs awaiting your review;
  `review-requested:` misses team-based requests (HN 2016; GitHub
  Community #189938).
- No turn tracking; PRs languish and reviewers get chased manually:
  "Manually remind them in direct messages. All day. Everyday."
  (r/github, 2024).

Deep-review-side:

- Comments marked "Outdated" hide the relevant code after new
  commits: "where is the new code?" (r/github, 2024). File-level
  comments get outdated on *any* push even if the file wasn't
  touched (GitHub Community #86527).
- No interdiff / "changes since my last review" view: "you have to
  review the whole thing over and over again" (HN 2016;
  r/ExperiencedDevs 2021; r/git 2024 comparing to Gerrit).
- Force-push/rebase detaches or loses review comments (HN, 2023).
- "Changes requested" sticks after the author pushes fixes; unclear
  how the turn passes back to the reviewer (r/github, 2022).
- Stale approvals: "get it reviewed / approved, then change 100% of
  the underlying code and still merge it" (HN, 2016).
- Resolved conversations hide content; unresolved-thread tracking
  is lossy (r/ExperiencedDevs, 2021).
- Large PRs are slow/unusable: collapsed "Load diff" files, seconds
  of lag per interaction (r/rust 2022; GitHub Community #39341).

Pain points we deliberately do not address (out of scope: in-app
code review): inline comments breaking diff reading flow, flat
top-level comment threading, stacked-PR review, diff context
windows.

## Part 3: Feature Specs

Each spec lists surface, derivation (data already in our domain
model unless noted), and status relative to current V1 plans
([core-workflow-plan.md](core-workflow-plan.md),
[reviewer-ui-v1-spec.md](reviewer-ui-v1-spec.md)).

### F1. Turn-based attention classification

The research strongly validates our existing lane model and
sharpens it: model the inbox as Gerrit-style turns, not as a PR
list with filters.

- **Surface:** inbox lanes; the classification itself is the
  product's spine.
- **Derivation:** per PR, compute whose turn it is from review
  requests, review submissions, commits/pushes, and thread events.
  Key turn-passing rules: review requested → your turn; you
  request changes → author's turn; author pushes after your
  changes-requested review → your turn again (this directly fixes
  the documented "changes requested sticks" confusion); author
  replies to your unresolved thread → your turn.
- **Spec:** keep "Needs your review" as the top lane. Every PR has
  exactly one turn owner at a time (you / author / other
  reviewers). Falls back to author when ambiguous, matching
  Reviewable's rule. Single-user caveat: we cannot observe other
  reviewers' intent (GitHub has no deferral signal), so
  "waiting on other reviewers" is best-effort from requested
  reviewers and their review states.
- **Status:** validates existing lanes; refine turn-passing rules.

### F2. "Why is this here" evidence trail

- **Surface:** quick peek (one line) and detail view (full trail).
- **Derivation:** the classification engine already produces a
  reason; extend it to keep the supporting events.
- **Spec:** quick peek shows a single deterministic reason string
  ("You were requested 3d ago"). Detail view shows the evidence
  trail: "Requested 3d ago → you requested changes 2d ago → author
  pushed 2 commits 4h ago → 2 threads you opened are unresolved."
  Every lane placement must be explainable from listed events;
  no unexplained placements.
- **Status:** planned (reason labels); this deepens it into a
  trail in the detail view.

### F3. Since-your-last-review delta

The most demanded missing GitHub feature in community threads.

- **Surface:** quick peek module ("Since your last visit" exists;
  add "since your last *review*") and detail view section.
- **Derivation:** store the head SHA at each of the user's review
  submissions. Delta = commits after that SHA (count, messages,
  force-push flag), new comments/threads since that timestamp, and
  files changed since (via GitHub compare API between the two
  SHAs).
- **Spec:** detail view gets a "Since your last review" block:
  N new commits (listed), M new comments, K threads resolved,
  force-push warning if history was rewritten. Link out to
  GitHub's two-dot compare URL for the actual interdiff — we do
  not render diffs in-app. Note: the claim that Reviewable does
  this via immutable revision snapshots was refuted in
  verification; design from our own stored review-submission SHAs
  instead.
- **Status:** new; high priority after V1 core.

### F4. Size chips

- **Surface:** inbox row + quick peek "current standing".
- **Derivation:** additions + deletions + changed-file count from
  PR metadata, bucketed S/M/L/XL with fixed documented thresholds
  (e.g. S ≤ 50 changed lines, M ≤ 250, L ≤ 1000, XL beyond).
- **Spec:** one small chip per row (e.g. "M · 7 files"). No file
  list in the peek (the files-touched module was deliberately
  removed as noise — keep that decision; a single chip is row
  metadata, not a file list). Caveat from research: raw size is
  noisy for mass deletions and automated refactors, so the chip
  informs ordering but never reclassifies a PR on its own.
- **Status:** new; small addition. Requires adding
  additions/deletions/changed-files to ingested PR metadata if not
  already stored.

### F5. Per-turn wait timers and staleness

- **Surface:** inbox row badge + detail header.
- **Derivation:** time since the turn owner (F1) last became the
  turn owner — i.e. how long the ball has been in the current
  court — not raw PR age. PR age shown separately.
- **Spec:** row shows "waiting on you 26h" / "waiting on author
  3d". Thresholds tint the badge (suggested defaults: amber > 24h,
  red > 72h on the current turn), justified by sub-day median
  review latencies in healthy loops. Thresholds are app settings,
  not magic; research numbers come from mandatory-review cultures
  and are directional only. Stale lane keeps using overall
  inactivity.
- **Status:** refines planned "time waiting" field with a
  per-turn definition.

### F6. Thread resolution ledger

- **Surface:** quick peek counts + detail view section.
- **Derivation:** GitHub GraphQL review threads expose
  `isResolved` and `isOutdated` natively; who-owes-reply = last
  commenter in each unresolved thread vs. viewer.
- **Spec:** detail view lists unresolved threads first, each with
  file/line, participants, who replied last (→ who owes a reply),
  and an "outdated by new commits" marker that keeps the thread
  visible instead of hiding it (directly answers the top community
  complaint). Quick peek shows "3 unresolved · 2 yours · 1 awaiting
  your reply". Add a review-rounds counter (number of
  changes-requested → push cycles); flag > 2 rounds as stuck,
  per Critique's 80%-one-iteration baseline.
- **Status:** planned (open threads module); adds who-owes-reply,
  outdated-but-visible, and the rounds counter.

### F7. Rationale-first detail header

- **Surface:** detail view, top section.
- **Derivation:** PR body, linked issues (closes/fixes references
  from the body), and commit messages — all already ingested or
  cheap to ingest.
- **Spec:** the detail view opens with *why this change exists*:
  PR description (rendered markdown), linked issue references, and
  the commit list with full messages. Activity and threads come
  after. Never open into raw event noise; rationale is the
  single biggest verified information need in deep review.
- **Status:** reorders planned detail sections; description and
  commit messages were not explicitly first-class before.

### F8. Two-tone ownership encoding

- **Surface:** every counter and badge, both views.
- **Derivation:** none — pure presentation of F1/F6 outputs.
- **Spec:** adopt Reviewable's proven encoding: one accent color
  for "you must act" counters, neutral gray for "others must act".
  A user should be able to scan the inbox and see their own
  obligations purely by color, before reading any text.
- **Status:** new UI rule; cheap, applies to existing fields.

### F9. Stale-approval warning

- **Surface:** inbox row + detail header.
- **Derivation:** compare head SHA to the SHA at the user's
  approval (same storage as F3).
- **Spec:** if the user approved and the author has since pushed,
  show "approved, then author pushed N commits" with the commit
  list in the detail view. Addresses the documented "approve, then
  change 100% of the code, still merge" complaint. This is state
  model rule 6 made visible as an explicit warning rather than
  just a lane move.
- **Status:** planned classification; spec makes the evidence
  explicit.

### F10. CI status and tests-touched chip (post-V1)

- **Surface:** inbox row chip + detail "current standing".
- **Derivation:** check runs / commit status API for the head SHA;
  tests-touched = any changed file path matching test conventions.
- **Spec:** row chip with passing/failing/pending; detail view
  breaks down failing checks. A "no tests touched" marker supports
  the verified accept/reject criteria (tests and CI results rank
  above contributor track record). Deferred: V1 explicitly
  excludes CI/check status; revisit immediately after V1 since
  triage research ranks CI state highly.
- **Status:** post-V1 by existing scope decision.

## Caveats

- The strongest pain-point surveys (2013/2015) predate GitHub's
  formal review system, conversation resolution, and notification
  inbox. Verifiers corroborated the *categories* as persistent via
  2024–2026 sources; exact UI complaints describe historical
  GitHub.
- Absolute numbers (4h median latency, 80% one-iteration, 5–7h
  answer delay) come from Google/Microsoft/OSS-integrator
  populations and are directional, not portable thresholds.
- Reviewable's per-file reviewed-at-revision marks and
  per-participant dispositions are app-local state, not derivable
  from GitHub data; cloning them would require our own state layer.
  Thread resolution, by contrast, is native GitHub GraphQL data.
- The Reddit/HN inventory in Part 2 is unverified community
  sentiment gathered via archive APIs (Reddit blocks crawlers);
  treat it as demand signal, not fact.

## Open Questions

- Which Gerrit/Reviewable turn rules survive on GitHub event data
  alone for a single-user app, given GitHub exposes no deferral or
  disposition signals from other reviewers?
- Should staleness thresholds be computed per-repo from historical
  turnaround percentiles instead of fixed defaults?
- Exact size-bucket thresholds, and whether to exclude generated/
  lock files from the count (GitHub marks some paths as generated).

## Key Sources

- Bacchelli & Bird, *Expectations, Outcomes, and Challenges of
  Modern Code Review* (ICSE 2013) — biggest information need is
  change rationale.
- Pascarella et al., *Information Needs in Contemporary Code
  Review* (CSCW 2018) — seven information-need categories from 900
  review threads. https://dl.acm.org/doi/10.1145/3274404
- Gousios et al., *Work Practices and Challenges in Pull-Based
  Development: The Integrator's Perspective* (ICSE 2015) — triage
  criteria, GitHub complaints.
  https://azaidman.github.io/publications/gousiosICSE2015.pdf
- Sadowski et al., *Modern Code Review: A Case Study at Google*
  (ICSE-SEIP 2018) — latency medians, size effects, unresolved
  comments as action items.
  https://sback.it/publications/icse2018seip.pdf
- Gerrit attention-set docs and design doc — turn-based model,
  "Your turn" dashboard, whose-turn use cases.
  https://gerrit-review.googlesource.com/Documentation/user-attention-set.html
  https://www.gerritcodereview.com/design-docs/attention-set-use-cases.html
- Reviewable docs — deterministic "waiting on" algorithm,
  discussion dispositions, completion rules.
  https://docs.reviewable.io/reviews
  https://docs.reviewable.io/discussions
- Community threads: HN 13127773 (GitHub review gaps, 2016), HN
  22568305 (notifications redesign, 2020), r/ExperiencedDevs
  oa8y81 (code review gripes, 2021), r/github 1g0s5to ("Code
  review in GitHub is horrendous", 2024), GitHub Community
  discussions #86527, #39341, #189938.
