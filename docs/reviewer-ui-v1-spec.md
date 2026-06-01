# Reviewer UI V1 Spec

## Motivation

GitHub is optimized around repositories and individual pull requests. This product is optimized around a reviewer who has too many PRs to keep in their head.

V1 should help the user answer four questions quickly:

- What needs my attention now?
- What am I waiting on?
- What changed since I last looked?
- Which PRs are ready for me to open in GitHub and approve or request changes?

The interface should not look or behave like a GitHub PR list. It should be an opinionated review operations surface: dense, prioritizing ownership and catch-up over chronology, and designed for scanning many PRs before opening a few.

## Reference

Use the root `Review Queue Wireframes (standalone).html` as the product reference. See [wireframe-reference.md](wireframe-reference.md) for how to reference it. The implementation should preserve the wireframe's intent, not necessarily its exact visual treatment.

The strongest v1 direction is the split queue plus quick peek pattern:

- Queue lanes on the left.
- A read-only catch-up panel on the right.
- PR detail screens centered on "what changed since your last visit" and raw activity.

## Scope

V1 is a single-user reviewer workflow.

Included:

- Reviewer inbox.
- PR catch-up/detail view.
- Deterministic activity and review-state computation from GitHub data.
- Local seen/caught-up state.
- Local triage actions such as caught up, snooze, pin, and mute.
- Links out to GitHub for actual review submission.

Excluded:

- AI or LLM summaries.
- CI/build/check status.
- Team workflows.
- GitHub auth/setup screens.
- In-app code review editor.
- In-app approve/request-changes submission.
- Generated recommendations.

## Core Concept

The app is not the place where the full review happens. It is the place where the reviewer catches up, decides priority, and opens GitHub only when ready.

The primary unit is a reviewer-owned PR item with derived workflow state. The core data model must remain workflow-independent; reviewer lanes are projections over GitHub entities, events, reviews, comments, timestamps, and local user state.

## Reviewer Inbox

The inbox should default to a dense lane-based layout rather than a generic table.

Primary lanes:

- Needs your review: PRs where the reviewer is currently expected to act.
- Waiting on author: PRs where the reviewer has already responded and the next move is not theirs.
- Watching / later: muted, snoozed, pinned, or low-priority PRs that should not disappear completely.
- Closed / merged: visible only as a secondary filter or recent-completion lane.

Each PR row should show:

- Repository and PR number.
- Title.
- Author.
- Current derived state.
- Time waiting on the user or author.
- Last meaningful activity.
- User's last review decision.
- Unseen activity count or "changed since last look" marker.
- Lightweight activity facts, such as new commits, new replies, unresolved threads, re-review requested.

Rows should be selected with keyboard navigation. Selection updates the quick peek panel without leaving the inbox.

## Quick Peek Panel

The quick peek panel is the main differentiator from GitHub.

It should answer, without opening the PR:

- Why is this in my queue?
- What changed since I last looked?
- Are my previous comments addressed?
- Are there unresolved threads I own?
- Is this likely ready to review in GitHub?

The panel must use raw deterministic data, not AI prose. Good v1 modules:

- Since your last visit: counts and bullets generated from events.
- Open threads: unresolved/resolved counts, author replies, reviewer-owned threads.
- Files touched since last look: file names and additions/deletions if available.
- Current standing: my review state, other review states, draft/open/closed/merged state.

Primary actions:

- Open in GitHub.
- Mark caught up.
- Snooze.
- Pin or mute.

## PR Detail View

The detail view should still be a catch-up surface, not a GitHub clone.

Top section:

- Back to inbox.
- Repository, PR number, author, created/updated timestamps.
- Title.
- Current reviewer obligation: waiting on you, waiting on author, caught up, closed, merged.
- User's previous review state.
- Other reviewers' states.
- Open in GitHub action.

Main content:

- What changed since you last looked.
- New commits count.
- New replies count.
- Threads addressed/unresolved count.
- Re-review requested marker.
- Deterministic list of recent activity items.
- Clear marker for "everything above is new since your last visit."

Side rail:

- Pick up where you left off.
- Open in GitHub.
- Mark caught up.
- Snooze/remind.
- Where it stands: my review, other reviewers, state, size.

## Activity Model

The UI should be powered by structured activity, not summaries.

Needed event types:

- PR opened, reopened, closed, merged.
- Review requested and re-requested.
- Review submitted: approved, changes requested, commented.
- Commit pushed / synchronized.
- Review thread opened, replied, resolved, unresolved.
- PR marked draft / ready for review.

Needed local state:

- Last seen timestamp per PR.
- Caught-up timestamp per PR.
- Snooze until timestamp.
- Pinned flag.
- Muted flag.

Derived UI facts:

- New events since last seen.
- New commits since last seen.
- New author replies since last seen.
- Unresolved reviewer-owned threads.
- Whether user's last review is still current.
- Whether author has acted after user's review.

## Workflow States

Reviewer-facing workflow states should be computed outside the core model.

Minimum v1 states:

- Needs review: reviewer is requested, PR is open and ready, user has not reviewed latest meaningful activity.
- Re-review requested: author or GitHub explicitly requested the reviewer again.
- Waiting on author: user requested changes or commented, and no author activity indicates it is ready again.
- Caught up: user has marked it seen/caught up after latest meaningful activity.
- Approved: user's latest review is approval and no later author change requires attention.
- Draft / not ready: PR is draft or otherwise not actionable.
- Closed / merged: not actionable, retained for recent context.

## Interaction Requirements

Keyboard support should be treated as part of v1:

- `j` / `k` move selection.
- `Enter` opens detail or GitHub depending on focused control.
- `e` opens in GitHub.
- `s` snoozes.
- `m` mutes.
- `p` pins.
- `c` marks caught up.
- `/` focuses search/filter.

Mouse interactions should mirror keyboard behavior. Lane headers should collapse/expand. Row actions should not cause layout shift.

## Visual Direction

Use shadcn/ui Rhea as the base style because it is compact and built for focused product interfaces.

The UI should feel:

- Dense but calm.
- Operational rather than editorial.
- Different from GitHub.
- Built around lanes, catch-up, and review ownership.
- Dark-mode friendly, but not dependent on dark mode.

Avoid:

- Marketing sections.
- Large empty cards.
- GitHub-like repository-first lists.
- AI-looking summary treatments.
- Decorative visuals that reduce scan density.

## Initial Implementation Shape

Build the new UI from the wireframe rather than incrementally polishing the current screens.

Suggested route structure:

- `/` or `/inbox`: lane-based review inbox with quick peek.
- `/pull-requests/:id`: catch-up detail and activity timeline.

Suggested component groups:

- `ReviewInboxPage`
- `ReviewLane`
- `ReviewQueueRow`
- `QuickPeekPanel`
- `PrDetailHeader`
- `ChangedSinceLastSeen`
- `ActivityTimeline`
- `ReviewStandingRail`
- `TriageActions`

Suggested shadcn components:

- Button
- Badge
- Card or Item for compact repeated surfaces
- Tabs or segmented control for filters
- Dropdown Menu
- Tooltip
- Scroll Area
- Separator
- Kbd

Keep the first implementation deterministic and data-backed. If a fact cannot be computed from stored GitHub/local state, do not show it in v1.
