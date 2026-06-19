export const localDesktopSchemaSql = `
pragma foreign_keys = on;

create table if not exists local_profile (
  id text primary key,
  github_login text,
  github_account_id text,
  display_name text,
  avatar_url text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists github_credential_refs (
  id text primary key,
  profile_id text not null references local_profile(id) on delete cascade,
  auth_provider text not null,
  keychain_service text,
  keychain_account text,
  gh_host text,
  github_login text,
  token_prefix text,
  scopes_json text not null default '[]',
  repository_selection_json text not null default '{}',
  expires_at text,
  last_validated_at text,
  validation_error text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  revoked_at text,
  check (auth_provider in ('os_keychain', 'github_cli'))
);

create table if not exists github_accounts (
  id text primary key,
  github_node_id text not null unique,
  login text not null unique,
  account_type text not null,
  avatar_url text,
  html_url text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  check (account_type in ('user', 'organization', 'bot'))
);

create table if not exists github_repositories (
  id text primary key,
  github_node_id text not null unique,
  owner_account_id text references github_accounts(id) on delete set null,
  full_name text not null unique,
  name text not null,
  is_private integer not null default 0,
  default_branch text,
  html_url text not null,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  check (is_private in (0, 1))
);

create table if not exists github_teams (
  id text primary key,
  github_node_id text unique,
  organization_account_id text references github_accounts(id) on delete set null,
  slug text not null,
  name text not null,
  html_url text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (organization_account_id, slug)
);

create table if not exists github_labels (
  id text primary key,
  repository_id text not null references github_repositories(id) on delete cascade,
  github_node_id text unique,
  name text not null,
  color text,
  description text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (repository_id, name)
);

create table if not exists tracked_repositories (
  id text primary key,
  profile_id text not null references local_profile(id) on delete cascade,
  repository_id text not null references github_repositories(id) on delete cascade,
  credential_ref_id text references github_credential_refs(id) on delete set null,
  sync_enabled integer not null default 1,
  poll_interval_seconds integer not null default 300,
  last_sync_started_at text,
  last_sync_finished_at text,
  last_sync_error text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  archived_at text,
  unique (profile_id, repository_id),
  check (sync_enabled in (0, 1))
);

create table if not exists pull_requests (
  id text primary key,
  github_node_id text not null unique,
  repository_id text not null references github_repositories(id) on delete cascade,
  number integer not null,
  title text not null,
  body text,
  url text not null,
  author_account_id text references github_accounts(id) on delete set null,
  state text not null,
  is_draft integer not null default 0,
  mergeable_state text,
  review_decision text,
  status_check_summary_json text not null default '{}',
  base_ref text,
  head_ref text,
  latest_commit_sha text,
  additions integer,
  deletions integer,
  changed_files integer,
  github_created_at text,
  github_updated_at text,
  closed_at text,
  merged_at text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (repository_id, number),
  check (state in ('open', 'closed')),
  check (is_draft in (0, 1)),
  check (
    review_decision is null
    or review_decision in ('approved', 'changes_requested', 'review_required', 'unknown')
  )
);

create index if not exists pull_requests_repository_updated_idx
  on pull_requests (repository_id, github_updated_at desc);

create table if not exists pull_request_labels (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  label_id text not null references github_labels(id) on delete cascade,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (pull_request_id, label_id)
);

create table if not exists pull_request_assignees (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  account_id text not null references github_accounts(id) on delete restrict,
  created_at text not null default current_timestamp,
  unique (pull_request_id, account_id)
);

create table if not exists pull_request_review_requests (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  reviewer_kind text not null,
  account_id text references github_accounts(id) on delete restrict,
  team_id text references github_teams(id) on delete restrict,
  requested_at text,
  created_at text not null default current_timestamp,
  check (reviewer_kind in ('user', 'team')),
  check (
    (reviewer_kind = 'user' and account_id is not null and team_id is null)
    or
    (reviewer_kind = 'team' and team_id is not null and account_id is null)
  )
);

create unique index if not exists pull_request_review_requests_user_idx
  on pull_request_review_requests (pull_request_id, account_id)
  where reviewer_kind = 'user';

create unique index if not exists pull_request_review_requests_team_idx
  on pull_request_review_requests (pull_request_id, team_id)
  where reviewer_kind = 'team';

create table if not exists review_events (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  reviewer_account_id text references github_accounts(id) on delete set null,
  decision text not null,
  commit_sha text,
  body text,
  submitted_at text not null,
  raw_payload_json text not null default '{}',
  check (decision in ('approved', 'changes_requested', 'commented', 'dismissed', 'pending'))
);

create index if not exists review_events_pull_request_submitted_idx
  on review_events (pull_request_id, submitted_at desc);

create table if not exists pull_request_check_runs (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_database_id integer,
  name text not null,
  app_slug text not null default '',
  head_sha text not null,
  status text not null,
  conclusion text,
  started_at text,
  completed_at text,
  details_url text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (pull_request_id, name, head_sha, app_slug),
  check (status in ('queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending')),
  check (
    conclusion is null
    or conclusion in (
      'action_required',
      'cancelled',
      'failure',
      'neutral',
      'success',
      'skipped',
      'stale',
      'timed_out'
    )
  )
);

create index if not exists pull_request_check_runs_pr_status_idx
  on pull_request_check_runs (pull_request_id, status, conclusion);

create table if not exists review_threads (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  is_resolved integer not null default 0,
  is_outdated integer not null default 0,
  last_actor_login text,
  file_path text,
  line integer,
  start_line integer,
  last_activity_at text not null,
  raw_payload_json text not null default '{}',
  check (is_resolved in (0, 1)),
  check (is_outdated in (0, 1))
);

create index if not exists review_threads_pull_request_activity_idx
  on review_threads (pull_request_id, last_activity_at desc);

create table if not exists review_thread_participants (
  id text primary key,
  review_thread_id text not null references review_threads(id) on delete cascade,
  account_id text not null references github_accounts(id) on delete cascade,
  created_at text not null default current_timestamp,
  unique (review_thread_id, account_id)
);

create table if not exists review_comments (
  id text primary key,
  review_thread_id text references review_threads(id) on delete cascade,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  author_account_id text references github_accounts(id) on delete set null,
  body text not null,
  file_path text,
  line integer,
  created_at_github text not null,
  updated_at_github text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists issue_comments (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  author_account_id text references github_accounts(id) on delete set null,
  body text not null,
  created_at_github text not null,
  updated_at_github text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists activity_events (
  id text primary key,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  github_delivery_id text,
  github_node_id text,
  event_type text not null,
  actor_account_id text references github_accounts(id) on delete set null,
  occurred_at text not null,
  title text not null,
  body text,
  raw_payload_json text not null default '{}',
  created_at text not null default current_timestamp
);

create index if not exists activity_events_pull_request_occurred_idx
  on activity_events (pull_request_id, occurred_at desc);

create index if not exists activity_events_type_occurred_idx
  on activity_events (event_type, occurred_at desc);

create unique index if not exists activity_events_delivery_type_idx
  on activity_events (github_delivery_id, event_type)
  where github_delivery_id is not null;

create table if not exists boards (
  id text primary key,
  profile_id text not null references local_profile(id) on delete cascade,
  name text not null,
  is_default integer not null default 0,
  sort_order integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  archived_at text,
  check (is_default in (0, 1))
);

create unique index if not exists boards_one_default_idx
  on boards (profile_id, is_default)
  where is_default = 1 and archived_at is null;

create unique index if not exists boards_active_name_idx
  on boards (profile_id, name)
  where archived_at is null;

-- A board item records that a pull request is on the board, plus the
-- reviewer's private per-PR state (last-seen marker and notes). Board
-- membership is the scope contract every surface keys on.
create table if not exists board_items (
  id text primary key,
  board_id text not null references boards(id) on delete cascade,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  last_seen_at text,
  notes text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  archived_at text,
  unique (board_id, pull_request_id)
);

create table if not exists board_filter_memberships (
  id text primary key,
  board_id text not null references boards(id) on delete cascade,
  fingerprint text not null,
  github_search_query text not null,
  pull_request_id text not null references pull_requests(id) on delete cascade,
  sort_order integer not null default 0,
  matched_at text not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (fingerprint, pull_request_id)
);

create index if not exists board_filter_memberships_scope_sort_idx
  on board_filter_memberships (board_id, fingerprint, sort_order);

create table if not exists sync_cursors (
  id text primary key,
  tracked_repository_id text not null references tracked_repositories(id) on delete cascade,
  cursor_kind text not null,
  cursor_value text,
  etag text,
  last_seen_at text,
  updated_at text not null default current_timestamp,
  unique (tracked_repository_id, cursor_kind)
);

create table if not exists sync_runs (
  id text primary key,
  tracked_repository_id text references tracked_repositories(id) on delete set null,
  credential_ref_id text references github_credential_refs(id) on delete set null,
  source text not null,
  status text not null,
  scanned_pull_requests integer not null default 0,
  ingested_pull_requests integer not null default 0,
  ingested_reviews integer not null default 0,
  ignored_pull_requests integer not null default 0,
  error text,
  started_at text not null default current_timestamp,
  finished_at text,
  check (status in ('running', 'succeeded', 'failed'))
);

create table if not exists app_settings (
  key text primary key,
  value_json text not null,
  updated_at text not null default current_timestamp
);

-- Generated AI summaries, cached per pull request and summary kind. The
-- cache_key is a hash of the exact input the summary was generated from, so
-- a stored row is reused until the underlying data changes. Only AI mode
-- touches this table. (No semicolons in this comment: the schema runner
-- splits statements on them.)
create table if not exists ai_summaries (
  pull_request_id text not null,
  kind text not null,
  cache_key text not null,
  model text not null,
  content_json text not null,
  generated_at text not null default current_timestamp,
  primary key (pull_request_id, kind),
  check (kind in ('pr-brief', 'ai-dashboard'))
);

-- Persisted chat conversations for the dashboard chat overlay. A thread is
-- scoped to the board filter it was started under (board_fingerprint) so
-- reopening the overlay restores the matching conversation. Messages are the
-- durable transcript: the AI provider is never relied on to remember history.
create table if not exists chat_threads (
  id text primary key,
  board_fingerprint text not null,
  title text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  archived_at text
);

create index if not exists chat_threads_board_idx
  on chat_threads (board_fingerprint, archived_at, updated_at desc);

create table if not exists chat_messages (
  id text primary key,
  thread_id text not null references chat_threads(id) on delete cascade,
  role text not null,
  content text not null,
  model text,
  created_at text not null default current_timestamp,
  check (role in ('user', 'assistant', 'system'))
);

create index if not exists chat_messages_thread_idx
  on chat_messages (thread_id, created_at);
`;
