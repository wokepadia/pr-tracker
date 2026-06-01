import { Migration } from "@mikro-orm/migrations";

export class Migration20260601140000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "github_installations" (
        "id" uuid primary key,
        "github_installation_id" integer not null unique,
        "account_login" text not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null
      );
    `);

    this.addSql(`
      create table if not exists "pull_requests" (
        "id" uuid primary key,
        "installation_id" uuid not null,
        "github_node_id" text not null unique,
        "repository" text not null,
        "number" integer not null,
        "title" text not null,
        "url" text not null,
        "author_login" text not null,
        "state" text not null,
        "is_draft" boolean not null,
        "latest_commit_sha" text not null,
        "raw_payload" jsonb not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null
      );
    `);

    this.addSql(`create index if not exists "pull_requests_repository_number_index" on "pull_requests" ("repository", "number");`);
    this.addSql(`create index if not exists "pull_requests_installation_id_index" on "pull_requests" ("installation_id");`);
    this.addSql(`create index if not exists "pull_requests_updated_at_index" on "pull_requests" ("updated_at");`);
    this.addSql(`alter table "pull_requests" add constraint "pull_requests_installation_id_foreign" foreign key ("installation_id") references "github_installations" ("id") on update cascade on delete cascade;`);

    this.addSql(`
      create table if not exists "review_events" (
        "id" uuid primary key,
        "pull_request_id" uuid not null,
        "github_node_id" text not null unique,
        "reviewer_login" text not null,
        "decision" text not null,
        "commit_sha" text null,
        "body" text null,
        "submitted_at" timestamptz not null,
        "raw_payload" jsonb not null
      );
    `);

    this.addSql(`create index if not exists "review_events_pull_request_id_index" on "review_events" ("pull_request_id");`);
    this.addSql(`create index if not exists "review_events_reviewer_login_index" on "review_events" ("reviewer_login");`);
    this.addSql(`alter table "review_events" add constraint "review_events_pull_request_id_foreign" foreign key ("pull_request_id") references "pull_requests" ("id") on update cascade on delete cascade;`);

    this.addSql(`
      create table if not exists "activity_events" (
        "id" uuid primary key,
        "pull_request_id" uuid not null,
        "github_delivery_id" text null,
        "event_type" text not null,
        "actor_login" text not null,
        "occurred_at" timestamptz not null,
        "title" text not null,
        "body" text null,
        "raw_payload" jsonb not null
      );
    `);

    this.addSql(`create index if not exists "activity_events_pull_request_id_index" on "activity_events" ("pull_request_id");`);
    this.addSql(`create index if not exists "activity_events_event_type_index" on "activity_events" ("event_type");`);
    this.addSql(`create index if not exists "activity_events_occurred_at_index" on "activity_events" ("occurred_at");`);
    this.addSql(`create unique index if not exists "activity_events_delivery_event_unique" on "activity_events" ("github_delivery_id", "event_type") where "github_delivery_id" is not null;`);
    this.addSql(`alter table "activity_events" add constraint "activity_events_pull_request_id_foreign" foreign key ("pull_request_id") references "pull_requests" ("id") on update cascade on delete cascade;`);

    this.addSql(`
      create table if not exists "webhook_deliveries" (
        "id" uuid primary key,
        "delivery_id" text not null unique,
        "event_name" text not null,
        "action" text null,
        "installation_id" integer null,
        "received_at" timestamptz not null,
        "raw_payload" jsonb not null
      );
    `);

    this.addSql(`create index if not exists "webhook_deliveries_event_name_index" on "webhook_deliveries" ("event_name");`);
    this.addSql(`create index if not exists "webhook_deliveries_installation_id_index" on "webhook_deliveries" ("installation_id");`);
    this.addSql(`create index if not exists "webhook_deliveries_received_at_index" on "webhook_deliveries" ("received_at");`);

    this.addSql(`
      create table if not exists "local_pull_request_states" (
        "id" uuid primary key,
        "pull_request_id" uuid not null,
        "viewer_login" text not null,
        "last_seen_at" timestamptz null,
        "is_muted" boolean not null,
        "is_pinned" boolean not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null
      );
    `);

    this.addSql(`create unique index if not exists "local_pull_request_states_pull_request_id_viewer_login_unique" on "local_pull_request_states" ("pull_request_id", "viewer_login");`);
    this.addSql(`alter table "local_pull_request_states" add constraint "local_pull_request_states_pull_request_id_foreign" foreign key ("pull_request_id") references "pull_requests" ("id") on update cascade on delete cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "local_pull_request_states";`);
    this.addSql(`drop table if exists "webhook_deliveries";`);
    this.addSql(`drop table if exists "activity_events";`);
    this.addSql(`drop table if exists "review_events";`);
    this.addSql(`drop table if exists "pull_requests";`);
    this.addSql(`drop table if exists "github_installations";`);
  }
}
