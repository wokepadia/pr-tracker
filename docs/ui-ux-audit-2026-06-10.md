# UI/UX Audit — 2026-06-10

Visual audit of the desktop reviewer app, performed in a browser against the
Vite dev server with sample data (desktop viewport, 1440px). Each numbered
item below is a self-contained task that can be handed to an agent as-is.

## How to reproduce the audit environment

The app's data layer calls Tauri `plugin:sql` over IPC, so plain `vite dev`
fails in a browser with `Cannot read properties of undefined (reading
'invoke')`. A temporary shim backs `plugin:sql` with sql.js (SQLite in wasm):

- `apps/desktop/public/tauri-browser-shim.js` (TEMP, do not commit)
- a `<script>` tag in `apps/desktop/index.html` head (TEMP, do not commit)
- `.claude/launch.json` config `desktop-web` starts the server

Then load the app in a browser, walk through onboarding, and click
"Use sample data" to seed the inbox. The shim is a no-op inside real Tauri
(it only installs when `__TAURI_INTERNALS__` is absent). Note:
`databasePromise` in `apps/desktop/src/desktop/tauri-data.ts` is never reset
after rejection, so the shim must be present before the app's first invoke —
a reload after injecting it too late will not recover.

## High impact

### 1. Board cards waste width and truncate titles

The drag handle + avatar sit in a left column, squeezing the title into
~120px so almost every title wraps to 3 lines and still truncates
("Normalize review request webhook…").

**Fix:** Restructure the card so the title spans the full card width; put
repo/#, avatar, and drag handle in a slim meta row above it, and reserve
truncation for 2 lines max.

**Files:** `apps/desktop/src/pages/InboxPage.tsx` (board card component,
~line 2219 region).

### 2. PR detail repeats the same fact up to five times

"Waiting on you 8d" (stat tile) = "attention: waiting on you" (Where it
stands) = "1 new event" chip = "Unseen events, 1 since 9d ago" tile =
"1 review request" chip = "maya requested your review" (shown twice: summary
card and timeline). Two separate rows of dashboard tiles, many showing
`none`/`0/0`.

**Fix:** Collapse into one status strip (review state, who's waiting, unseen
count) plus the timeline; hide any metric whose value is none/zero.

**Files:** `apps/desktop/src/pages/PullRequestPage.tsx`.

### 3. Inbox header stack is redundant and partly fake

"Review Inbox · 3 active PRs across user buckets" sits directly above
"Review board · 3 active PRs arranged in editable user buckets" plus a
static "Board" badge that looks like a button but is a `<span>`.

**Fix:** Merge into a single header, drop the "user buckets" jargon, and
remove or functionalize the Board badge.

**Files:** `apps/desktop/src/pages/InboxPage.tsx:1768` and
`apps/desktop/src/pages/InboxPage.tsx:1953`.

### 4. The header ignores the selected view

Clicking "New activity" (badge: 2) filters the list, but the title still
reads "Review Inbox · 3 active PRs", and the Buckets/Repo toggle silently
resets to Buckets.

**Fix:** Title + count should follow the active view ("New activity ·
2 PRs"), and the group-by toggle should persist per view.

**Files:** `apps/desktop/src/pages/InboxPage.tsx`.

### 5. Raw GitHub query bar is the most prominent element in the app

The monospace `is:open user-review-requested:@me` + Apply + reset row sits
above the page title. It is a power feature, not the primary action.

**Fix:** Collapse it into a "Sync query" disclosure/popover next to the sync
status (keep Apply/reset inside), so the default header starts at "Review
Inbox".

**Files:** `apps/desktop/src/pages/InboxPage.tsx` (query bar near top of the
page component).

### 6. Sticky chrome lets content ghost through on scroll

At shorter viewports (~900px) the page itself scrolls and the
semi-transparent sticky top bar shows the query bar/title bleeding through
behind it; the third card gets cut off.

**Fix:** Make the app a full-height layout (`h-screen` grid) where board
*columns* scroll internally and the header stays fixed and opaque — the
standard kanban pattern.

**Files:** `apps/desktop/src/app/AppFrame.tsx`,
`apps/desktop/src/pages/InboxPage.tsx`.

## Medium impact

### 7. Every card in the Inbox column wears an "Inbox" chip

The bucket chip duplicates the column the card is already in (and the
sidebar selection).

**Fix:** Hide the bucket chip in the Buckets board view; keep it in Repo
grouping and flat list views where it adds information.

**Files:** `apps/desktop/src/pages/InboxPage.tsx`.

### 8. Cryptic icon chips need words or tooltips

`+1`, `1/1`, the eye-icon "requested", and the bare `you`/`author` pills
carry meaning only insiders know (extra reviewers? threads resolved?).

**Fix:** Add tooltips to every chip and prefer short labels ("1 of 1 threads
resolved", "+1 reviewer"); make sure each has an `aria-label`.

**Files:** `apps/desktop/src/pages/InboxPage.tsx`,
`apps/desktop/src/pages/inbox-helpers.ts`.

### 9. Peek panel: duplicated exits and noisy empty states

The ⤢ icon (actually a link to detail) duplicates "Open PR detail" at the
bottom; "Sneak peek" is unclear; empty Notes takes the top slot and "Open
threads · 0 of 0 unresolved / No open review threads" spends two rows saying
nothing.

**Fix:** Title the panel with `repo/#142`, keep one clearly-labeled "Open
full view" affordance, collapse empty sections to a one-line "Add note", and
hide the threads section when empty.

**Files:** `apps/desktop/src/pages/InboxPage.tsx:2735` onward.

### 10. PR detail right rail mixes actions with status

"Bucket: Inbox" is styled as a button among actions (Mark caught up,
Snooze…) but reads as a label; "Review 1 new event" and "Open in GitHub"
both appear to open GitHub without explaining the difference.

**Fix:** Make the bucket row an explicit select ("Move to bucket…"), and
differentiate the CTAs (e.g. "Open in GitHub · 1 new event" as the single
primary).

**Files:** `apps/desktop/src/pages/PullRequestPage.tsx`.

### 11. PR detail left column ordering

Empty Notes block sits above the PR description, and "No description
provided." gets a full card.

**Fix:** Order description → activity, render notes as a compact "Add note"
affordance when empty, and shrink the no-description placeholder to one
muted line.

**Files:** `apps/desktop/src/pages/PullRequestPage.tsx`.

### 12. Settings form fields look disabled

Gray-filled inputs with gray placeholder text read as read-only; there is a
large dead gap under "Token storage" and the "Not configured" badge floats
unanchored.

**Fix:** Use the standard bordered input style (match onboarding's), tighten
the token-storage block, and put the configured/not-configured status inline
next to the field label.

**Files:** `apps/desktop/src/pages/SettingsPage.tsx`,
`apps/desktop/src/components/GithubSettingsForm.tsx`.

## Lower impact / polish

### 13. Bucket color dots are nearly indistinguishable

Waiting (green) vs Done (teal) are close; Later's pale gray dot is almost
invisible on white.

**Fix:** Pick a 5-color set with clear separation and sufficient contrast,
used consistently in sidebar dots, column headers, and card edge stripes.

**Files:** bucket color map in `apps/desktop/src/pages/InboxPage.tsx` /
theme.

### 14. Repo-list rows have ragged right metadata

"you · Inbox · 8d · waiting on you" stacks into three right-aligned
mini-rows of different sizes; repo group counts sit at the far right edge,
disconnected from the repo name.

**Fix:** One metadata line per row with fixed order (bucket chip · age ·
status), and move the count chip next to the repo name.

**Files:** `apps/desktop/src/pages/InboxPage.tsx` (repo grouping section).

### 15. Duplicate branding and top-bar tagline

"Review Ninja" appears in both the top bar and sidebar header; "tracker, not
a review surface · review happens in GitHub" permanently occupies the top
bar and duplicates the bottom-left sidebar note.

**Fix:** Keep the brand in the sidebar only, drop the tagline from the top
bar.

**Files:** `apps/desktop/src/app/AppFrame.tsx`.

### 16. Empty board columns are inert

"No PRs." in a dashed box, five times across the screen.

**Fix:** Per-column empty hints that teach the workflow ("Drag a PR here
when you start reviewing"), shown only in the Buckets view.

**Files:** `apps/desktop/src/pages/InboxPage.tsx:2114`.

## Structural note

`apps/desktop/src/pages/InboxPage.tsx` is 3,094 lines and contains the
board, list, repo grouping, and the peek panel — most items above land in
it. Before dispatching several of these in parallel, run a mechanical
"extract board card / peek panel / list row into components" task so agents
don't collide.

**Suggested order:** 6 → 1 → 3 → 5 (layout/chrome first, they touch shared
structure), then 2/10/11 (detail page), then the rest in any order.
