-- PR Tracker SaaS database schema proposal.
-- This is PostgreSQL-flavored DDL intended for import into online database
-- visualizers that support SQL DDL.

create extension if not exists pgcrypto;

create table app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table github_accounts (
  id uuid primary key default gen_random_uuid(),
  github_node_id text not null unique,
  login text not null unique,
  account_type text not null,
  avatar_url text,
  html_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (account_type in ('user', 'organization', 'bot'))
);

create table user_github_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  github_account_id uuid not null references github_accounts(id) on delete restrict,
  github_login_at_link_time text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, github_account_id),
  unique (github_account_id)
);

create table user_github_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  github_account_id uuid references github_accounts(id) on delete restrict,
  credential_kind text not null,
  token_name text not null,
  token_prefix text,
  token_fingerprint_hmac bytea not null,
  encrypted_token_ciphertext bytea not null,
  encrypted_token_data_key bytea not null,
  encryption_key_id text not null,
  encryption_algorithm text not null,
  scopes jsonb not null default '[]'::jsonb,
  repository_selection jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  last_validated_at timestamptz,
  validation_error text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (credential_kind in ('fine_grained_pat', 'classic_pat')),
  check (encryption_algorithm in ('AES-256-GCM-envelope'))
);

create unique index user_github_credentials_active_fingerprint_idx
  on user_github_credentials (token_fingerprint_hmac)
  where revoked_at is null;

create table github_repositories (
  id uuid primary key default gen_random_uuid(),
  github_node_id text not null unique,
  owner_account_id uuid not null references github_accounts(id) on delete restrict,
  full_name text not null unique,
  name text not null,
  is_private boolean not null,
  default_branch text,
  html_url text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_repository_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  repository_id uuid not null references github_repositories(id) on delete cascade,
  credential_id uuid references user_github_credentials(id) on delete set null,
  sync_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, repository_id)
);

create table pull_requests (
  id uuid primary key default gen_random_uuid(),
  github_node_id text not null unique,
  repository_id uuid not null references github_repositories(id) on delete cascade,
  number integer not null,
  title text not null,
  body text,
  url text not null,
  author_account_id uuid references github_accounts(id) on delete restrict,
  state text not null,
  is_draft boolean not null default false,
  base_ref text,
  head_ref text,
  latest_commit_sha text,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  closed_at timestamptz,
  merged_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, number),
  check (state in ('open', 'closed', 'merged'))
);

create index pull_requests_repository_updated_idx
  on pull_requests (repository_id, github_updated_at desc);

create table pull_request_labels (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  name text not null,
  color text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pull_request_id, name)
);

create table pull_request_assignees (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  account_id uuid not null references github_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (pull_request_id, account_id)
);

create table pull_request_reviewers (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  account_id uuid not null references github_accounts(id) on delete restrict,
  requested_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pull_request_id, account_id)
);

create table review_events (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  reviewer_account_id uuid references github_accounts(id) on delete restrict,
  decision text not null,
  commit_sha text,
  body text,
  submitted_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  check (decision in ('approved', 'changes_requested', 'commented', 'dismissed', 'pending'))
);

create index review_events_pull_request_submitted_idx
  on review_events (pull_request_id, submitted_at desc);

create table review_threads (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  is_resolved boolean not null default false,
  file_path text,
  line integer,
  start_line integer,
  last_activity_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb
);

create index review_threads_pull_request_activity_idx
  on review_threads (pull_request_id, last_activity_at desc);

create table review_thread_participants (
  id uuid primary key default gen_random_uuid(),
  review_thread_id uuid not null references review_threads(id) on delete cascade,
  account_id uuid not null references github_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (review_thread_id, account_id)
);

create table review_comments (
  id uuid primary key default gen_random_uuid(),
  review_thread_id uuid references review_threads(id) on delete cascade,
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  author_account_id uuid references github_accounts(id) on delete restrict,
  body text not null,
  file_path text,
  line integer,
  created_at_github timestamptz not null,
  updated_at_github timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table issue_comments (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_node_id text not null unique,
  author_account_id uuid references github_accounts(id) on delete restrict,
  body text not null,
  created_at_github timestamptz not null,
  updated_at_github timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table activity_events (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_delivery_id text,
  github_node_id text,
  event_type text not null,
  actor_account_id uuid references github_accounts(id) on delete restrict,
  occurred_at timestamptz not null,
  title text not null,
  body text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_events_pull_request_occurred_idx
  on activity_events (pull_request_id, occurred_at desc);

create unique index activity_events_delivery_type_idx
  on activity_events (github_delivery_id, event_type)
  where github_delivery_id is not null;

create table user_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, user_id)
);

create unique index user_boards_one_default_idx
  on user_boards (user_id)
  where is_default and archived_at is null;

create unique index user_boards_active_name_idx
  on user_boards (user_id, name)
  where archived_at is null;

create table user_board_columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references user_boards(id) on delete cascade,
  name text not null,
  color text,
  sort_order integer not null,
  width_px integer not null default 232,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (width_px between 160 and 640)
);

create unique index user_board_columns_active_name_idx
  on user_board_columns (board_id, name)
  where archived_at is null;

create unique index user_board_columns_active_sort_idx
  on user_board_columns (board_id, sort_order)
  where archived_at is null;

create table user_board_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  board_id uuid not null,
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  column_id uuid references user_board_columns(id) on delete set null,
  sort_order integer not null default 0,
  last_seen_at timestamptz,
  last_seen_activity_at timestamptz,
  is_muted boolean not null default false,
  is_pinned boolean not null default false,
  added_by text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (user_id, board_id, pull_request_id),
  foreign key (board_id, user_id) references user_boards(id, user_id) on delete cascade,
  check (added_by in ('user', 'subscription', 'sync_rule'))
);

create index user_board_items_column_sort_idx
  on user_board_items (user_id, column_id, sort_order);

create index user_board_items_board_pinned_idx
  on user_board_items (user_id, board_id, is_pinned, updated_at desc);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  repository_id uuid references github_repositories(id) on delete set null,
  credential_id uuid references user_github_credentials(id) on delete set null,
  status text not null,
  scanned_pull_requests integer not null default 0,
  ingested_pull_requests integer not null default 0,
  ingested_reviews integer not null default 0,
  ignored_pull_requests integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (status in ('running', 'succeeded', 'failed'))
);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  event_name text not null,
  action text,
  received_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index webhook_deliveries_event_received_idx
  on webhook_deliveries (event_name, received_at desc);

create table credential_access_events (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references user_github_credentials(id) on delete cascade,
  purpose text not null,
  success boolean not null,
  error_code text,
  occurred_at timestamptz not null default now()
);

create index credential_access_events_credential_occurred_idx
  on credential_access_events (credential_id, occurred_at desc);
