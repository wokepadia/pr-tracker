# Local Desktop Database Schema Proposal

This document refreshes the database direction for a local-only desktop V1. The
app should keep user data on the user's machine, use SQLite for durable app
state, and keep GitHub credentials out of the database.

The importable schema is in
[local-desktop-database-schema.sql](local-desktop-database-schema.sql). It is
SQLite-flavored DDL because the V1 runtime database should be an embedded local
database, and many free online database visualizers can import SQLite-style SQL.

## Product Requirements Covered

- The user's board is persisted locally in SQLite.
- Board labels/columns are local to this desktop profile.
- Fetched GitHub data is cached locally so the UI can read from SQLite.
- Board membership is stored separately from GitHub facts.
- GitHub credentials are stored in the OS keychain or GitHub CLI credential
  store, never in SQLite.
- The design keeps a later hybrid/server model possible without making V1 depend
  on a server.

## High-Level ER View

```mermaid
erDiagram
  local_profile ||--o{ github_credential_refs : uses
  local_profile ||--o{ boards : owns

  github_credential_refs o|--o{ tracked_repositories : syncs
  github_credential_refs o|--o{ sync_runs : used_by

  github_accounts o|--o{ github_repositories : owns
  github_accounts o|--o{ pull_requests : authors
  github_accounts o|--o{ github_teams : owns

  github_repositories ||--o{ tracked_repositories : tracked_as
  github_repositories ||--o{ pull_requests : contains
  github_repositories ||--o{ github_labels : defines

  pull_requests ||--o{ pull_request_labels : has
  pull_requests ||--o{ pull_request_assignees : has
  pull_requests ||--o{ pull_request_review_requests : requests
  pull_requests ||--o{ review_events : has
  pull_requests ||--o{ pull_request_check_runs : has
  pull_requests ||--o{ review_threads : has
  pull_requests ||--o{ review_comments : has
  pull_requests ||--o{ issue_comments : has
  pull_requests ||--o{ activity_events : has
  pull_requests ||--o{ board_items : appears_on

  review_threads ||--o{ review_thread_participants : includes
  github_labels ||--o{ pull_request_labels : applied_as
  github_teams ||--o{ pull_request_review_requests : requested_as

  boards ||--o{ board_columns : has
  boards ||--o{ board_items : contains
  board_columns o|--o{ board_items : groups

  tracked_repositories ||--o{ sync_cursors : has
  tracked_repositories ||--o{ sync_runs : records
```

## Table Groups

### Local Profile And Credential References

`local_profile` stores the local viewer identity, such as the GitHub login used
to classify "needs my review" and "updated since I looked." This is not an
account table for a SaaS user. V1 can create one profile row, while the schema
keeps `profile_id` on local configuration tables so a later multi-profile
desktop mode does not require reshaping the GitHub cache.

`github_credential_refs` stores only metadata and pointers to where the token can
be found. For example:

- `auth_provider = 'os_keychain'` with `keychain_service` and
  `keychain_account`.
- `auth_provider = 'github_cli'` with `gh_host`, relying on `gh auth token` or a
  GitHub CLI library/harness.

The table deliberately has no encrypted token column. A desktop app can use
macOS Keychain, Windows Credential Manager, or Linux Secret Service through a
cross-platform keychain library. If the user chooses the GitHub CLI path, the
GitHub CLI owns credential storage.

`github_credential_refs.github_login` can differ from `local_profile.github_login`
because a local profile may later use multiple GitHub accounts or credentials
for different hosts/repositories. If V1 only supports one GitHub identity, the
app can keep the two values identical.

### Local GitHub Cache

`github_accounts`, `github_teams`, `github_repositories`, `github_labels`,
`pull_requests`, review tables, check-run tables, comment tables, and
`activity_events` model GitHub facts. These rows are cached locally and are not
owned by a board. A PR should be stored once in the local cache even if it
appears in multiple boards later.

The schema keeps `raw_payload_json` fields so ingestion can be deterministic and
we can re-project details without immediately re-fetching every GitHub object.
Those payloads are intentionally a V1 cache/debug aid and should be pruned,
compressed, or omitted selectively if database size becomes a problem.

The PR `state` column follows GitHub's REST API shape: `open` or `closed`.
Merged state is derived from `merged_at`, not stored as a third state. Review
readiness and merge readiness are cached separately through `review_decision`,
`mergeable_state`, `status_check_summary_json`, and `pull_request_check_runs`.

`review_events.decision` includes `pending` for API fidelity with GitHub's
GraphQL `PullRequestReviewState`. A REST-only sync path should expect mostly
submitted review states and may never write pending reviews.

`pull_request_review_requests` supports both user and team review requests.
GitHub exposes team review requests separately from user requests, so V1 should
not collapse them into account rows.

`github_labels` is repository-scoped, and `pull_request_labels` is only the
join table. This avoids duplicating label color/description on every PR and
makes label filtering a direct indexed lookup later.

### Repository Tracking And Sync

`tracked_repositories` is local profile configuration for which repositories the
desktop app syncs. It points at a credential reference when private or
authenticated access is needed. It has `archived_at` for the same reason board
objects do: users may remove a repository from active sync without immediately
destroying cached troubleshooting context.

`sync_cursors` stores ETags, pagination cursors, since timestamps, or other
per-repository sync state. This is where we avoid wasteful polling and support
incremental refresh.

`sync_runs` records sync attempts for troubleshooting. This matters more in a
desktop app because users need clear local diagnostics when a token expires, a
rate limit is hit, or the laptop resumes after sleep.

### Local Board Data

`boards` is the local profile's board container. V1 can start with one default
board.

`board_columns` stores the user's editable labels/columns. This replaces the
current browser `localStorage` label storage and includes `width_px` for the
resizable Kanban layout.

`board_items` determines which cached PRs appear on the board. It links a board
to a PR and stores local workflow state such as column placement, sort order,
pinned/muted/snoozed state, private notes, and last-seen timestamps. It also
carries a few viewer relationship fields so hot-path board queries do not need
to repeatedly derive "I authored this", "I am requested", or "I have unresolved
threads" by joining the whole GitHub cache.

This is the important boundary:

- GitHub cache tables answer "what exists on GitHub?"
- Board tables answer "how does this local user organize and process it?"

## Credential Storage Decision

For local-only V1, use OS-backed credential storage rather than database
encryption:

1. Store GitHub tokens in the OS credential store:
   - macOS Keychain
   - Windows Credential Manager
   - Linux Secret Service/libsecret
2. Store only a lookup reference in SQLite.
3. Support GitHub CLI auth as a developer-friendly path when available.
4. Never write tokens to SQLite, logs, crash reports, screenshots, or exported
   debug bundles.
5. When calling GitHub, read the token into memory, use it for the request, and
   discard it as soon as practical.

This is simpler and more defensible than server-side PAT storage for a personal
desktop app. It also makes the security story easy to explain: the app owns the
board database, but the operating system owns the secret.

## SQLite Mechanics

SQLite does not automatically refresh `updated_at` on update just because a
column has `default current_timestamp`. V1 should either set `updated_at` in app
code on every write or add explicit triggers with the first real migration. The
schema proposal uses defaults only for insert-time values.

Cache join rows such as assignees, review requests, and thread participants keep
restricting foreign keys to account/team cache rows because the join rows stop
being useful without their target identity. Main entity author/owner links use
`on delete set null` so cached PRs and repositories can survive identity cache
pruning.

Column ordering uses non-unique `sort_order` indexes. Reorder code can assign
temporary duplicate values during drag operations and normalize later without
fighting uniqueness constraints. Board item ordering follows the same rule.

The `width_px` check is deliberately broad enough for likely desktop layouts,
but the UI should still own final min/max validation. If the design changes, the
database range should be treated as a corruption guard, not the product spec.

`board_items.added_by` is limited to `user` for V1. Subscription-driven and
rule-driven auto-add flows should add their own enum values when those workflows
actually exist.

## Desktop Problems And V1 Mitigations

### No Reliable Webhooks

V1 should poll GitHub. Use `sync_cursors` for ETags and incremental refresh, and
make the refresh interval visible/configurable later. Webhook freshness can be
revisited in a hybrid model.

### Per-User Rate Limits

Every desktop user syncs independently. V1 should keep the sync scope narrow:
only selected repositories, open PRs first, and incremental updates. A later
server can cache public repository facts if this becomes painful.

### Weak Background Sync

V1 should sync while the app is open. A background helper can come later, but it
should not be required for the first local version.

### Multi-Device State

V1 is local-only. Boards do not sync across devices. The first escape hatch
should be export/import or user-controlled backup of the SQLite database.

### Sharing And Team Workflows

V1 is a personal cockpit. Shared boards, team labels, and organization dashboards
belong in a later server-backed mode.

## Hybrid Path Later

The schema keeps the future hybrid model clear:

- Desktop keeps private credentials and private board state local.
- A server can later cache public repository facts.
- A server can later store encrypted backup blobs, not plaintext board rows.
- Shared/team boards can become a separate server-backed feature instead of
  changing the local-only V1 storage contract.

## Source Notes

GitHub API references used for schema fidelity:

- REST pull request `state` uses `open` and `closed`; merged status is derived
  from merge fields/endpoints:
  https://docs.github.com/en/rest/pulls/pulls
- REST requested reviewers include both user reviewers and team reviewers:
  https://docs.github.com/en/rest/pulls/review-requests
- REST check runs expose status and conclusion fields:
  https://docs.github.com/en/rest/checks/runs
- GraphQL pull requests expose review and status-check rollups:
  https://docs.github.com/en/graphql/reference/objects#pullrequest

## Migration Shape From The Current App

1. Create a desktop storage package backed by SQLite.
2. Add OS keychain or GitHub CLI credential access.
3. Move current browser `localStorage` keys for labels, card bucket, item order,
   last-seen state, pinned/muted state, and column width into `boards`,
   `board_columns`, and `board_items`.
4. Move GitHub fetch results from API/sample state into local GitHub cache
   tables.
5. Make the UI read from a local repository interface so a future hybrid/server
   source can be added behind the same boundary.

## Implementation Notes

- The SQL file is a proposal, not a migration yet.
- IDs are `text` so the app can use UUIDs, GitHub node IDs, or stable generated
  IDs where appropriate.
- Booleans are stored as `integer` with `0`/`1` checks for SQLite compatibility.
- JSON fields are stored as `text` so the schema works in SQLite builds without
  depending on JSON extensions.
- `archived_at` is used for board objects so destructive UI actions can be
  reversible before hard deletion policies are added.
