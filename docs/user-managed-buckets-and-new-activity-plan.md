# User-Managed Buckets And New Activity Plan

## Goal

Replace hard-coded reviewer labels like "Needs you" with generic, editable user buckets, while making new activity impossible to miss.

The app should support two separate ideas:

- Buckets are where the user chooses to keep a PR.
- New activity is a freshness signal layered on top of any bucket.

This keeps user organization stable without hiding the fact that a PR changed after the user last looked at it.

## Product Principle

Do not make the app's computed workflow state fight the user's organization.

The app can still compute facts such as "new commits arrived" or "review was re-requested", but those facts should explain urgency, not permanently name the bucket unless the user chooses that bucket.

## Decision 1: What Replaces Hard-Coded Labels?

### Option A: Fully User-Managed Buckets

The app starts with generic buckets, and the user can rename them, reorder them, add buckets, remove buckets, and move PRs between them.

Example starter buckets:

- Inbox
- Reviewing
- Waiting
- Later
- Done

Criteria:

- Best when the user wants control.
- Best when the app should not assume one team's workflow.
- Needs a clear new-activity layer so buckets do not become stale.

### Option B: App-Suggested Buckets With Editable Names

The app keeps deterministic default groupings, but the user can rename the visible bucket names.

Criteria:

- Best when we still want strong app guidance.
- Easier to implement as a transition from the current model.
- Risky because renamed buckets may still behave like old hard-coded workflow states.

### Option C: User Buckets Plus App Hints

The user controls buckets. The app adds small, separate hints such as "new commits", "re-review requested", "unresolved thread", or "waiting on author".

Criteria:

- Best balance for this product direction.
- Keeps buckets stable.
- Keeps deterministic GitHub facts visible.
- Avoids stale bucket names because freshness is shown separately.

Recommended direction: Option C.

## Decision 2: Should A PR Be In One Bucket Or Many?

### Option A: One Primary Bucket Per PR

Each PR lives in exactly one user bucket. Moving it is simple: choose the target bucket.

Criteria:

- Best for a queue-style workflow.
- Easy to understand: every PR has one home.
- Matches the user's "move from one bucket to another" expectation.

### Option B: Multiple Labels Per PR

A PR can have several user labels at once.

Criteria:

- Best for flexible tagging.
- More expressive, but easier to make messy.
- Harder to show as clean lanes because one PR may appear many times.

### Option C: One Primary Bucket Plus Optional Tags Later

Start with one primary bucket. Leave room for optional tags only after the main workflow is working.

Criteria:

- Best for V1 discipline.
- Keeps the reviewer loop clear.
- Does not block future richer organization.

Recommended direction: Option C, implemented initially as Option A.

## Decision 3: How Should New Activity Interact With Buckets?

### Option A: Move PRs Automatically To A New Activity Bucket

When new activity arrives, the app moves the PR into a special "New activity" bucket.

Criteria:

- Very visible.
- Risky because it changes the user's bucket choices.
- Can make the app feel unpredictable.

### Option B: Keep PRs In Their Bucket And Add A New Activity Badge

New activity appears as a badge, count, accent, or small activity summary wherever the PR already lives.

Criteria:

- Preserves user organization.
- Makes staleness visible without moving things.
- Needs strong visual treatment so users do not miss it.

### Option C: Keep PRs In Their Bucket And Also Show A New Activity View

PRs stay in their bucket, but a left-side "New activity" tab gathers all PRs with unseen activity.

Criteria:

- Best when the user wants both stable buckets and a catch-up queue.
- Avoids surprising moves.
- Gives the user one place to process everything that changed.

Recommended direction: Option C.

## Decision 4: What Counts As New Activity?

### Option A: Any GitHub Event

Every event after the user's last seen time counts as new activity.

Criteria:

- Simple and complete.
- Can be noisy.
- May over-alert on low-value metadata changes.

### Option B: Meaningful Reviewer Activity Only

Only events that may change the user's review decision count.

Examples:

- New commits or force pushes
- New comments or review replies
- Review requested again
- Review submitted, dismissed, or changed
- Thread resolved or reopened
- Draft changed to ready for review

Criteria:

- Better for a review cockpit.
- Keeps the activity signal focused.
- Requires clear rules so the user understands why something is marked new.

### Option C: Two Levels Of Activity

Show all raw events in detail, but mark only meaningful events as "new activity" in the inbox.

Criteria:

- Best balance between completeness and signal.
- Keeps the inbox focused.
- Still lets the detail view show everything.

Recommended direction: Option C.

## Decision 5: Where Should New Activity Appear?

### Option A: PR Row Only

Show a badge or count directly on each PR row.

Criteria:

- Good for scanning inside a bucket.
- Not enough if the user wants one catch-up view across all buckets.

### Option B: Quick Peek And Detail Only

Show new activity after the user selects or opens the PR.

Criteria:

- Keeps the inbox calmer.
- Too easy to miss before selecting the PR.

### Option C: Everywhere The User Makes A Decision

Show new activity in the left navigation, PR row, quick peek, and PR detail.

Criteria:

- Best for the user's request.
- Makes new activity hard to miss.
- Requires consistent wording so the same signal means the same thing everywhere.

Recommended direction: Option C.

## Decision 6: Should There Be A Left-Side New Activity Tab?

### Option A: No New Activity Tab

Only show new activity inside existing buckets.

Criteria:

- Simpler navigation.
- Works if users mostly live inside their buckets.
- Weak for catch-up mode.

### Option B: A Dedicated New Activity Tab

Add a left-side tab that gathers PRs with unseen meaningful activity, regardless of bucket.

Criteria:

- Best for quickly catching up.
- Supports the existing wireframe idea of a review cockpit.
- Must make clear that this is a view, not a bucket.

### Option C: New Activity As A Filter Toggle

Let users toggle "show only PRs with new activity" in the current bucket.

Criteria:

- Useful inside a bucket.
- Less discoverable than a left-side tab.
- Better as a secondary control.

Recommended direction: Option B, with Option C as a later enhancement.

## Decision 7: How Should Quick Actions Work?

### Option A: Quick Actions Only In PR Detail

Move PR, mark caught up, snooze, pin, and mute only appear on the detail page.

Criteria:

- Simple.
- Too slow for inbox triage.

### Option B: Quick Actions On Rows And Detail

Expose actions on each row and repeat them in the detail view.

Criteria:

- Good baseline.
- Still leaves the quick peek weaker than it should be.

### Option C: Quick Actions Everywhere

Expose the same actions in the row, quick peek footer, detail header or side rail, and keyboard command surface.

Criteria:

- Best for fast triage.
- Matches the user's request.
- Needs a consistent action set so users do not hunt for controls.

Recommended direction: Option C.

Core quick actions:

- Move to bucket
- Mark caught up
- Snooze
- Pin
- Mute
- Open in GitHub

## Decision 8: When Does New Activity Clear?

### Option A: Clear When The PR Is Opened

Opening the PR detail marks activity as seen.

Criteria:

- Simple.
- Risky because a user may open and leave without actually catching up.

### Option B: Clear Only When The User Marks Caught Up

The user explicitly clears new activity.

Criteria:

- More intentional.
- Better for trust.
- Adds one extra action.

### Option C: Detail Opens Mark Items As Viewed, But Caught Up Clears The Badge

The detail view can show what the user has viewed, but the inbox badge stays until "Caught up" is clicked.

Criteria:

- Best balance.
- Keeps explicit control over the queue signal.
- Lets the detail page still show a useful "new since last visit" boundary.

Recommended direction: Option C.

## Decision 9: What Happens To App-Computed Workflow States?

### Option A: Remove Them Entirely

The app only shows user buckets and raw activity.

Criteria:

- Maximum user control.
- Loses useful deterministic reviewer facts.

### Option B: Keep Them As Hidden Sorting Logic

The app uses computed states to sort, but does not show them clearly.

Criteria:

- Keeps some intelligence.
- Risky because behavior becomes hard to explain.

### Option C: Keep Them As Transparent Hints

The app computes facts and displays them as evidence chips, not bucket names.

Examples:

- "review requested"
- "author pushed after your review"
- "thread reopened"
- "waiting on author"

Criteria:

- Best fit for the domain model guidance.
- Keeps raw GitHub facts reusable.
- Avoids hard-coded visible labels as the main organization system.

Recommended direction: Option C.

## Proposed User Experience

The left side has two kinds of navigation:

- Views: New activity, All PRs, Pinned, Snoozed, Muted.
- Buckets: user-managed lanes such as Inbox, Reviewing, Waiting, Later, Done.

The main inbox can show PRs grouped by bucket. Every PR row can also show whether it has new activity.

The quick peek should always show:

- Current bucket and move action.
- New activity since the user last caught up.
- Important deterministic facts.
- Quick actions.

The PR detail should show:

- Current bucket and move action near the top.
- A clear "New activity" section.
- The full raw activity timeline.
- A side rail with the same quick actions as the inbox.

The "New activity" left-side tab should be a view over all buckets, not a bucket. Moving a PR out of one bucket should not remove its new activity badge. Marking it caught up should remove it from the New activity view.

## Simple Success Criteria

The new direction is working if:

- A user can rename buckets without breaking the review workflow.
- A user can move a PR between buckets from the row, quick peek, and detail.
- A PR with new commits or comments is visibly marked even if it stays in its old bucket.
- The New activity view shows changed PRs across all buckets.
- Marking a PR caught up clears the new activity signal.
- The detail view still shows what changed since the user last caught up.
- App-computed facts explain the PR state without becoming fixed bucket names.

## Suggested Phased Plan

### Phase 1: Product Model Shift

Define local user buckets as the visible organization model. Keep deterministic GitHub facts as separate hints and activity signals.

Deliverable:

- Updated product docs and naming.
- Starter bucket set.
- Clear rule that a PR has one primary user bucket.

### Phase 2: Inbox And Quick Actions

Replace hard-coded visible lanes with editable user buckets. Add move actions in rows, quick peek, and detail.

Deliverable:

- User can move PRs between buckets.
- Quick actions are available everywhere decision-making happens.

### Phase 3: New Activity Layer

Add new activity as a cross-bucket signal based on meaningful events since the user last caught up.

Deliverable:

- Row badges/counts.
- Quick peek new activity section.
- Detail new activity section and timeline boundary.

### Phase 4: New Activity View

Add the left-side New activity tab as a view over all buckets.

Deliverable:

- New activity count in navigation.
- All changed PRs gathered in one place.
- Clear caught-up action that removes PRs from the view.

## Open Product Questions

- Should starter buckets be created automatically for every user, or should the first-run screen ask the user to name them?
- Should "Done" hide merged and closed PRs, or should those remain a separate recent-completion view?
- Should "Muted" be a bucket, a view, or an action that hides PRs from normal buckets?
- Should snoozed PRs stay in their bucket with a snooze badge, or move to a Snoozed view until the snooze expires?
- Should moving a PR to "Done" automatically mark it caught up?
