import { Migration } from "@mikro-orm/migrations";

export class Migration20260601160000_syncRuns extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "sync_runs" (
        "id" uuid primary key,
        "source" text not null,
        "status" text not null,
        "scanned_pull_requests" integer not null,
        "ingested_pull_requests" integer not null,
        "ingested_reviews" integer not null,
        "ignored_pull_requests" integer not null,
        "error" text null,
        "started_at" timestamptz not null,
        "finished_at" timestamptz null
      );
    `);

    this.addSql(`create index if not exists "sync_runs_source_index" on "sync_runs" ("source");`);
    this.addSql(`create index if not exists "sync_runs_status_index" on "sync_runs" ("status");`);
    this.addSql(`create index if not exists "sync_runs_started_at_index" on "sync_runs" ("started_at");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "sync_runs";`);
  }
}
