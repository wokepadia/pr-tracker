# Reviewer UI Phase 1 Implementation Spec

## Goal

Rebuild the frontend from scratch around the reference wireframe instead of iterating on the current UI.

Phase 1 should produce a faithful implementation of the reviewer queue and PR detail structure from `Review Queue Wireframes (standalone).html`, with no AI features. The app should feel like a review operations cockpit for users who lose track of PR reviews because there are too many concurrent threads.

The implementation should prioritize exact structure, placement, density, and workflow over polish. Visual styling should use shadcn/ui Rhea as the base system.

## Canonical Reference

Use the root `Review Queue Wireframes (standalone).html` directly as the source of truth. See [wireframe-reference.md](wireframe-reference.md).

Primary phase-1 wireframe targets:

- Inbox: `Inbox C — Split + catch-up peek`
- PR detail: `Detail E — Activity timeline`
- Secondary detail reference: `Detail D — Catch-up digest` for header, fact strip, and side-rail action placement only

Do not use `Inbox A` or `Inbox B` as the implementation structure. They are useful alternatives, but phase 1 should implement the split queue and quick peek.

## Non-Goals

Do not implement:

- AI summaries.
- "Generated just now" UI.
- Regenerate controls.
- LLM-backed bottom lines.
- CI/check/build status.
- Team workflows.
- Auth/setup screens.
- In-app code review or diff review.
- In-app approve/request-changes submission.

Review submission still happens in GitHub. This app helps the user catch up, triage, and decide what to open.

## Frontend Reset

When implementation begins, delete the existing frontend implementation and rebuild from scratch.

Expected replacement scope:

- Replace current `apps/web/src` UI screens/components/styles.
- Preserve project-level tooling only if still useful.
- Use the Rhea scaffold/components as the visual base.
- Keep backend/API contracts separate from visual structure so mock data can drive the first pass.

Do not try to preserve the current table-first UI. It does not match the wireframe direction.

## Implementation Checkpoints

Implement this phase as feature checkpoints. Each checkpoint needs focused QA and a code-review pass before commit.

1. Foundation: Rhea/shadcn styling, clean app shell, deterministic mock data, and routing skeleton.
2. Inbox: `Inbox C` sidebar, header, action lanes, queue rows, quick peek placement, and row selection.
3. Inbox interactions: keyboard movement, quick-peek updates, caught-up/snooze actions, and GitHub link behavior.
4. Detail: `Detail E` header, deterministic context band, activity timeline, unseen marker, and side rail.
5. Polish: visual comparison against the HTML wireframe, empty/loading/error states only where needed, and final build/test pass.

Do not add fallback UI paths for data that phase 1 does not support. If a fact is unavailable from deterministic mock or API-shaped data, omit that element for now rather than inventing a generic fallback.

## Phase 1 Screens

Implement two app screens:

1. Review inbox at `/` or `/inbox`
2. PR detail at `/pull-requests/:id`

Both screens must use the same top product frame and the same dense, dark, operational style.

## Global App Frame

Match the wireframe's global structure:

- Fixed top bar across the viewport.
- Top-left product label: `Review Queue`.
- Top-center or near-center screen/navigation controls only if needed during development; production app can omit wireframe tab controls.
- Top-right status copy: `tracker, not a review surface · review happens in GitHub` or equivalent.
- Main stage below the top bar.
- Dark app background.
- Large framed application surface centered inside the stage.

The app should not look like GitHub. It should not use repository-first page hierarchy.

## Inbox Layout

Implement the `Inbox C` structure exactly at the layout level.

Desktop structure, left to right:

1. Left sidebar navigation.
2. Main content frame.
3. Inside main content:
   - Header bar at top.
   - Queue lanes on the left.
   - Quick peek panel on the right.

Approximate proportions from the wireframe:

- Left sidebar: narrow fixed rail, about one fifth of the app frame.
- Queue area: about 55-60% of remaining content.
- Quick peek: about 40-45% of remaining content.
- Quick peek stays visible while selecting different PR rows.

### Inbox Sidebar

Place the sidebar on the far left.

Required sections and order:

1. Product mark/name.
2. Primary review buckets:
   - Needs you
   - Changed since
   - Waiting on author
   - Approved · recent
3. Stashed section:
   - Snoozed
   - Watching

Each row should have:

- Small icon/marker slot.
- Label.
- Count on the right.
- Active state styling.

Repo filters are not required in phase 1. If included, they must remain below the primary workflow buckets and must not become the main navigation model.

### Inbox Header

Place the inbox header at the top of the main content area, above both queue and peek.

Required content and placement:

- Left: `Review Inbox`
- Immediately after title: sync recency, such as `· synced 2m ago`
- Right: grouping control, default `group: action`
- Far right: keyboard hint, such as `j / k to move`

### Queue Lanes

Place lanes in the left pane under the inbox header.

Required lane order:

1. Needs your review
2. Changed since you last looked
3. Waiting on author

`Needs your review` and `Changed since you last looked` should be expanded by default. `Waiting on author` may be collapsed by default.

Each lane header must include:

- Collapsible chevron.
- Lane label.
- Count.
- Subtle colored lane marker on the left.

### PR Row Structure

Rows must be dense and horizontally scanable.

Each row should preserve this information order:

1. Left accent/status marker.
2. Repo and PR number.
3. PR title.
4. Author or actor.
5. Compact fact chips:
   - new commits
   - new replies
   - unresolved/open threads
   - re-review requested
6. Right-side waiting/age indicator.

Selected row behavior:

- Selected row has a stronger background and left accent.
- Selecting a row updates the quick peek.
- `j` / `k` changes selection.

Do not use a full-width spreadsheet/table as the primary structure.

## Quick Peek Panel

Place the quick peek panel on the right side of the inbox, matching `Inbox C`.

The quick peek must be read-only and should answer "what changed since I looked?" without leaving the inbox.

Required panel structure, top to bottom:

1. Header
2. Body sections
3. Footer actions

### Quick Peek Header

Required content:

- Kicker: `Quick peek · no need to open`
- PR title.
- Metadata line:
  - repo / PR number
  - author
  - waiting state and age

### Quick Peek Body

Required sections and order:

1. Since your last visit
2. Open threads
3. Files touched since last look

The "Since your last visit" section must be deterministic. Use structured bullets and counts from stored events. Do not generate prose.

Example facts:

- `+2 new commits`
- `3 new replies on threads you opened`
- `author re-requested your review`

Open threads section should show:

- unresolved count
- total count
- compact thread rows
- whether the author replied
- whether each thread is resolved

Files touched section should show:

- file name
- additions/deletions if available
- only files changed since last look if that data exists

### Quick Peek Footer

Required actions and order:

1. Primary: `Open in GitHub to review`
2. Secondary: `Snooze`
3. Secondary: `Caught up`

These actions must stay anchored to the bottom of the peek panel.

## PR Detail Layout

Implement the PR detail screen using `Detail E — Activity timeline` as the main structure.

Desktop structure:

1. Top detail header.
2. Deterministic context band in the same location as the wireframe summary band.
3. Two-column body:
   - Main activity timeline on the left.
   - Side rail on the right.

### Detail Header

Place this at the top of the detail frame.

Required structure:

- Far left: `← Inbox` button.
- Main center-left content:
  - repo / PR number
  - opened by author
  - opened age
  - title
  - fact strip
- Right content:
  - user's current review standing
  - primary GitHub action or snooze action depending on state

Required fact strip examples:

- Updated: `1 hour ago`
- Your role: `required reviewer`
- Unseen events: `5 since 2d ago`

### Deterministic Context Band

The wireframe includes an AI-looking `Summary so far` band. Phase 1 must keep the same placement but replace the content with deterministic structured context.

Do not show:

- sparkle icon
- `generated just now`
- regenerate action
- AI-style paragraph summary
- `bottom line` generated recommendation

Instead, show a deterministic "Review context" band with compact facts:

- Your last review decision and time.
- Author activity since your review.
- Review request/re-request state.
- Open unresolved thread count.
- Other reviewers' latest states.

This preserves the layout slot without introducing AI.

### Activity Timeline

Place the timeline in the main left column under the context band.

Required structure:

- Section label: `Activity · newest first`
- Reverse chronological activity items.
- New/unseen items visually emphasized.
- Clear horizontal marker:
  - `everything above is new since you last looked · <time>`
- Older activity below the marker.

Required activity item types for phase 1:

- commit pushed
- review re-requested
- thread resolved
- thread replied
- review approved
- user requested changes
- PR opened

Each item should include:

- timestamp
- actor
- action text
- optional compact payload snippet

Do not include AI-generated interpretation of the item.

### Detail Side Rail

Place side rail on the right, matching the wireframe.

Required cards and order:

1. Catch up
2. Where it stands

Optional third card from `Detail D`:

3. Stay on it

Catch up actions:

- Primary: `Review the <n> new events`
- Secondary: `Mark all caught up`

Where it stands rows:

- your review
- other reviewers
- merge/review blocking state, but not CI

Do not show CI status in this rail.

## Data Needed For Phase 1 UI

The first frontend pass can use mock data shaped like the real API. The shape must support replacement with backend data later.

Minimum PR queue item fields:

- id
- repository
- number
- title
- authorLogin
- url
- state: open, draft, closed, merged
- workflowState
- waitingOn
- waitingAge
- updatedAt
- lastSeenAt
- userLastReviewDecision
- userLastReviewAt
- requestedReviewers
- otherReviewers
- unseenEventCount
- newCommitCount
- newReplyCount
- unresolvedThreadCount
- changedFilesSinceLastSeen
- isPinned
- isMuted
- snoozedUntil

Minimum detail fields:

- all queue item fields
- activityEvents newest first
- lastSeenMarkerTimestamp
- reviewThreads
- changedFiles

## Interaction Requirements

Phase 1 should implement these interactions even if backed by local/mock state:

- Select PR row.
- Update quick peek on selection.
- Navigate rows with `j` and `k`.
- Open selected PR detail with `Enter`.
- Return to inbox from detail.
- Mark caught up.
- Snooze.
- Pin/mute if visible.
- Open in GitHub using external link.

Keyboard shortcuts:

- `j`: next row
- `k`: previous row
- `Enter`: open detail
- `e`: open in GitHub
- `s`: snooze
- `c`: mark caught up
- `/`: focus search/filter if present

## Styling Requirements

Use shadcn/ui Rhea as the base style.

Rhea implementation requirements:

- Compact controls.
- Neutral dark product surface.
- Amber/accent color for "needs you" and changed/unseen activity.
- Low border contrast.
- Small typography.
- Monospace or tabular treatment for counts, repo names, and timestamps where useful.

Layout should remain stable:

- Row heights should not change when selected.
- Footer actions should stay anchored.
- Lane collapse should not resize the quick peek.
- Text should truncate cleanly.
- Buttons should not wrap unexpectedly.

## Acceptance Criteria

The phase is complete when:

- Existing frontend UI has been replaced with the new structure.
- Inbox matches the structural placement of `Inbox C`.
- PR detail matches the structural placement of `Detail E`, with Detail D header/rail patterns where useful.
- No AI summary, generated copy, or regenerate control appears anywhere.
- The quick peek updates when row selection changes.
- The activity timeline includes an unseen marker.
- The UI can be driven by deterministic mock data.
- The app builds cleanly.
- The implementation can be visually compared against the root HTML wireframe at a 1200px-wide desktop viewport.

## Open Questions For Later

These should not block phase 1:

- Whether review submission should ever happen inside this app.
- Whether files changed since last look require GitHub compare API support.
- Whether thread ownership requires GraphQL review-thread ingestion.
- Whether mobile layouts matter before the desktop workflow is stable.
