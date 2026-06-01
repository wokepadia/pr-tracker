# Core Workflow Plan

This document defines the first-pass product structure for a long-term GitHub PR review dashboard. It intentionally excludes generic setup concerns such as login, GitHub App installation, billing, deployment, and account management. The focus is the core single-user workflow: helping one power user understand which PRs need attention, what changed recently, and what action should happen next.

## Product Goal

Build a review cockpit for engineers who need to manage pull requests they are expected to review across multiple repositories without repeatedly opening GitHub tabs.

The product should answer four questions quickly:

1. What needs my attention now?
2. Why is this PR in that state?
3. What raw activity happened since I last looked?
4. What is the next sensible action?

The first version should focus only on the reviewer workflow. PRs authored by the user are out of scope unless they also appear in the reviewer's queue for another reason.

## Core User Loops

### Reviewer Loop

The reviewer opens the app and sees a prioritized queue of PRs grouped by action state.

Primary workflow:

1. Scan the queue.
2. Open a PR detail panel.
3. Scan recent activity, comments, reviews, and unresolved threads.
4. Inspect current review status: review state, unresolved threads, draft state, and requested reviewers.
5. Decide whether to review now, defer, ignore, or wait for the author.
6. Open GitHub only when deeper code inspection or commenting is needed.

The product is successful when the reviewer can decide where to spend review time without visiting each PR page. V1 should do this with structured GitHub data and deterministic state classification only; generated summaries and other LLM-dependent features are explicitly out of scope.

## Main App Surfaces

### 1. Review Inbox

The main surface is a dense, keyboard-friendly inbox. It should feel closer to an issue triage tool than a project dashboard.

Recommended sections:

- Needs my review
- Updated since my last review
- Waiting on author
- Changes requested by me
- Approved but not merged
- Stale / no movement
- Muted / watching only

Each PR row should show enough context to avoid opening the detail panel unnecessarily:

- Repository and PR number
- Title
- Author
- Age and last activity time
- Requested reviewers
- Latest review state
- Draft/ready status
- Unresolved thread count
- Comment/review activity count since last seen
- Small reason label explaining why it appears in its section

### 2. PR Detail Panel

The detail panel should be optimized for decision-making, not full code review.

Suggested sections:

- Header: title, repo, author, branch/base, and draft/ready state.
- Current classification: the app's state label and the evidence behind it.
- Recent activity: raw ordered events for comments, reviews, commits, review requests, thread resolution, and draft/ready changes.
- Conversation surface: issue comments and review comments grouped by thread or chronology.
- Review state: approvals, changes requested, comments, pending reviewers, dismissed reviews.
- Open threads: unresolved review threads grouped by topic/file when possible.
- Timeline: compact chronological event stream for users who want raw context.
- Actions: open in GitHub, mark seen, mute, pin, assign local status.

### 3. Saved Views

Saved views should come after the default inbox is useful. They are important for power users, but should not complicate the first version.

Examples:

- High-priority repos
- PRs older than 3 days
- PRs with unresolved threads
- PRs where I commented but have not approved

## PR State Model

GitHub has raw states and events, but the product needs derived reviewer workflow states. Each PR can have multiple facts, but should have one primary queue placement at a time for the current reviewer.

Recommended priority order:

1. Closed or merged: remove from active inbox.
2. Draft: place in draft/not ready unless user is explicitly watching drafts.
3. Viewer requested changes and author has not pushed since: waiting on author.
4. Viewer requested changes and author has pushed since: updated since my review.
5. Viewer review requested and PR is ready: needs my review.
6. Viewer previously reviewed and new commits were pushed: updated since my last review.
7. Unresolved thread involving viewer: needs attention.
8. Approved by viewer: approved / no reviewer action needed.
9. No recent activity beyond threshold: stale.
10. Otherwise: watching / lower priority.

This ordering should remain explainable. Every queue placement should be backed by a reason string, such as:

- "You were requested for review 4h ago."
- "Author pushed 2 commits after your last approval."
- "You requested changes; author has not pushed since."
- "You approved this PR yesterday."

## Activity Feed Model

V1 should expose activity as structured events, not generated summaries. The app should ingest and display these categories:

- New commits or force pushes
- Review requests added or removed
- Reviews submitted, dismissed, or edited
- Review comments added
- Review threads resolved or unresolved
- Issue comments added on the PR conversation
- Draft converted to ready for review, or ready converted to draft
- Labels, milestones, and assignees changed
- Merge queue or auto-merge events where available

The activity feed should separate raw facts from deterministic classification:

- Raw fact: "Maya requested changes."
- Raw fact: "Ari resolved a thread."
- Deterministic classification: "Waiting on author."

Generated natural-language summaries are out of scope for V1. Later, the product can add summaries as a projection over the same underlying event model.

## Conversation Surface Model

V1 should make the conversation easier to inspect without asking an LLM to interpret it. The conversation surface should provide:

- Top-level PR comments in chronological order.
- Review comments grouped by review thread when GitHub exposes thread data.
- Unresolved threads separated from resolved threads.
- Participant, timestamp, file path, and line context for review comments.
- Last activity markers since the viewer last saw the PR.
- Links that jump to the source GitHub discussion.

The app should not infer code correctness from metadata. It should present the discussion and review state accurately, then hand off to GitHub for full code review.

## Data Needed For Core Workflow

The workflow needs these GitHub data categories:

- Pull request metadata: title, body, state, draft flag, author, repo, labels, assignees, base/head refs, timestamps.
- Review requests: requested users.
- Reviews: reviewer, state, submitted time, body, dismissed status.
- Review comments: file path, line context, author, body, created/updated time.
- Review threads: resolved/unresolved state and participants.
- Issue comments: top-level PR conversation comments.
- Timeline events: ready-for-review, converted-to-draft, review-requested, review-request-removed, committed, head-ref-force-pushed, merged, closed, reopened, renamed, labeled, assigned.
- Commits and changed files: commit count, latest head SHA, file count, additions/deletions, optionally file paths.
- Viewer relationship: whether the viewer reviewed, commented, was directly requested, or is subscribed/watching.
- Local app state: last seen event, muted/pinned status, local notes/status, saved view membership.

## Event Ingestion Strategy

Use webhooks for freshness and periodic reconciliation for correctness.

Webhook-driven updates should react to:

- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`
- `pull_request_review_thread`
- `issue_comment`

Periodic reconciliation should:

- Re-fetch active PRs in installed repositories.
- Repair missed webhook delivery or out-of-order event handling.
- Drop merged/closed PRs from active queues after a retention window.

## Ranking

Within each section, sort by urgency rather than only recency.

Suggested signals:

- Explicitly requested from viewer
- Time waiting on viewer
- Activity since viewer last saw it
- PR age
- Number of reviewers involved
- Author is blocked by requested review
- Repository priority
- User-pinned PRs

Ranking should stay predictable. Avoid opaque "AI priority" as the default order. V1 ranking should be deterministic; any AI-assisted ranking, summaries, or suggestions are future work.

## First Milestone Scope

The first useful product slice should include:

- Review inbox with derived sections.
- PR detail panel with current status evidence.
- Raw activity feed based on recent events.
- Conversation surface based on comments/reviews.
- Local seen/muted/pinned state.
- Open-in-GitHub handoff for actual code review/commenting.

Explicitly defer:

- In-app code review.
- Posting comments or approving PRs.
- Reviewer assignment automation.
- Team/org workflows and analytics.
- Slack/email notifications.
- Custom workflow rules.
- Generated summaries or other LLM-dependent features.
- Authored PR management.
- Billing/admin features.

## Open Product Questions

- Should the inbox hide PRs where the viewer is only subscribed but not requested?
- How aggressive should stale detection be: fixed threshold, repo-level setting, or learned from the user's habits?
- Should "approved but not merged" remain visible to the reviewer, or leave the active inbox after approval?
- How should local statuses interact with GitHub-native labels and review states?

## Research Notes

GitHub's APIs and webhooks support the data shape needed for this workflow:

- Pull request APIs expose PRs, commits, changed files, requested reviewers, reviews, and review comments: [REST API endpoints for pull requests](https://docs.github.com/en/rest/reference/pulls).
- Timeline events cover activity across issues and pull requests, and GitHub treats pull requests as issues for shared conversation/event APIs: [REST API endpoints for timeline events](https://docs.github.com/en/rest/issues/timeline?apiVersion=2026-03-10).
- Webhooks are available for PR activity, PR reviews, review comments, review threads, and issue comments: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
- GraphQL exposes PR-specific objects such as `PullRequest`, `PullRequestReview`, `PullRequestReviewThread`, `ReviewRequestedEvent`, and `ReadyForReviewEvent`, which may be useful for efficient detail queries: [GraphQL object reference](https://docs.github.com/en/graphql/reference/objects).
- Existing review inbox products emphasize customizable inbox sections, real-time sync, comments, and keyboard-driven review flow, which validates the inbox-first direction: [Graphite Inbox](https://graphite.dev/features/inbox).
