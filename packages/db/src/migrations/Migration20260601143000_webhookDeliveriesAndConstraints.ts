import { Migration } from "@mikro-orm/migrations";

export class Migration20260601143000_webhookDeliveriesAndConstraints extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "webhook_deliveries" (
        "id" uuid primary key,
        "delivery_id" text not null unique,
        "event_name" text not null,
        "action" text null,
        "received_at" timestamptz not null,
        "raw_payload" jsonb not null
      );
    `);

    this.addSql(`create index if not exists "webhook_deliveries_event_name_index" on "webhook_deliveries" ("event_name");`);
    this.addSql(`create index if not exists "webhook_deliveries_received_at_index" on "webhook_deliveries" ("received_at");`);
    this.addSql(`create unique index if not exists "activity_events_delivery_event_unique" on "activity_events" ("github_delivery_id", "event_type") where "github_delivery_id" is not null;`);
    this.addSql(`create unique index if not exists "local_pull_request_states_pull_request_id_viewer_login_unique" on "local_pull_request_states" ("pull_request_id", "viewer_login");`);

    this.addSql(`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint where conname = 'pull_requests_account_id_foreign'
        ) then
          alter table "pull_requests"
            add constraint "pull_requests_account_id_foreign"
            foreign key ("account_id")
            references "github_accounts" ("id")
            on update cascade
            on delete cascade;
        end if;

        if not exists (
          select 1 from pg_constraint where conname = 'review_events_pull_request_id_foreign'
        ) then
          alter table "review_events"
            add constraint "review_events_pull_request_id_foreign"
            foreign key ("pull_request_id")
            references "pull_requests" ("id")
            on update cascade
            on delete cascade;
        end if;

        if not exists (
          select 1 from pg_constraint where conname = 'activity_events_pull_request_id_foreign'
        ) then
          alter table "activity_events"
            add constraint "activity_events_pull_request_id_foreign"
            foreign key ("pull_request_id")
            references "pull_requests" ("id")
            on update cascade
            on delete cascade;
        end if;

        if not exists (
          select 1 from pg_constraint where conname = 'local_pull_request_states_pull_request_id_foreign'
        ) then
          alter table "local_pull_request_states"
            add constraint "local_pull_request_states_pull_request_id_foreign"
            foreign key ("pull_request_id")
            references "pull_requests" ("id")
            on update cascade
            on delete cascade;
        end if;
      end $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "webhook_deliveries";`);
  }
}
