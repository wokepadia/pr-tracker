import { Migration } from "@mikro-orm/migrations";

export class Migration20260601150000_requestedReviewersAndThreads extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "pull_request_reviewers" (
        "id" uuid primary key,
        "pull_request_id" uuid not null,
        "reviewer_login" text not null,
        "created_at" timestamptz not null
      );
    `);

    this.addSql(`create unique index if not exists "pull_request_reviewers_pull_request_id_reviewer_login_unique" on "pull_request_reviewers" ("pull_request_id", "reviewer_login");`);
    this.addSql(`
      alter table "pull_request_reviewers"
        add constraint "pull_request_reviewers_pull_request_id_foreign"
        foreign key ("pull_request_id")
        references "pull_requests" ("id")
        on update cascade
        on delete cascade;
    `);

    this.addSql(`
      create table if not exists "review_threads" (
        "id" uuid primary key,
        "pull_request_id" uuid not null,
        "github_node_id" text not null unique,
        "is_resolved" boolean not null,
        "participant_logins" jsonb not null,
        "file_path" text null,
        "line" integer null,
        "last_activity_at" timestamptz not null,
        "raw_payload" jsonb not null
      );
    `);

    this.addSql(`create index if not exists "review_threads_pull_request_id_index" on "review_threads" ("pull_request_id");`);
    this.addSql(`create index if not exists "review_threads_is_resolved_index" on "review_threads" ("is_resolved");`);
    this.addSql(`create index if not exists "review_threads_last_activity_at_index" on "review_threads" ("last_activity_at");`);
    this.addSql(`
      alter table "review_threads"
        add constraint "review_threads_pull_request_id_foreign"
        foreign key ("pull_request_id")
        references "pull_requests" ("id")
        on update cascade
        on delete cascade;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_threads";`);
    this.addSql(`drop table if exists "pull_request_reviewers";`);
  }
}
