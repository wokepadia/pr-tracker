import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrations } from "./migrations";

function columnNames(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(`select name from sqlite_master where type = 'table' order by name`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("schema migrations", () => {
  it("creates the full schema on a fresh database and records every migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const ran = applyMigrations(db);

      expect(ran).toEqual(migrations.map((migration) => migration.id));

      const tables = tableNames(db);
      for (const table of [
        "pull_requests",
        "review_events",
        "review_threads",
        "review_thread_participants",
        "review_comments",
        "issue_comments",
        "pull_request_check_runs",
        "pull_request_labels",
        "pull_request_assignees",
        "pull_request_review_requests",
        "activity_events",
        "boards",
        "board_items",
        "board_filter_memberships",
        "ai_summaries",
        "chat_threads",
        "chat_messages",
        "schema_migrations",
      ]) {
        expect(tables).toContain(table);
      }

      const applied = (
        db
          .prepare(`select id from schema_migrations order by id`)
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(applied).toEqual(migrations.map((migration) => migration.id));
    } finally {
      db.close();
    }
  });

  it("is a no-op on a second run", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      expect(applyMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("brings a legacy database missing newer columns up to date", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // Simulate a database created before the migration ledger: the tables
      // exist (from the historical create-if-not-exists path) but lack the
      // columns added later, and there is no schema_migrations row.
      db.exec(`
        create table pull_requests (
          id text primary key,
          github_node_id text not null unique,
          repository_id text not null,
          number integer not null,
          title text not null,
          url text not null,
          state text not null,
          is_draft integer not null default 0,
          github_updated_at text,
          raw_payload_json text not null default '{}'
        );
        create table board_items (
          id text primary key,
          board_id text not null,
          pull_request_id text not null,
          last_seen_at text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        create table review_threads (
          id text primary key,
          pull_request_id text not null,
          github_node_id text not null unique,
          is_resolved integer not null default 0,
          file_path text,
          line integer,
          last_activity_at text not null,
          raw_payload_json text not null default '{}'
        );
      `);

      const ran = applyMigrations(db);
      expect(ran).toEqual(migrations.map((migration) => migration.id));

      // Columns added by later migrations now exist on the pre-existing tables.
      expect(columnNames(db, "board_items")).toContain("notes");
      expect(columnNames(db, "review_threads")).toEqual(
        expect.arrayContaining(["is_outdated", "last_actor_login"])
      );
      expect(columnNames(db, "pull_requests")).toEqual(
        expect.arrayContaining([
          "additions",
          "deletions",
          "changed_files",
          "mergeable_state",
          "review_decision",
          "status_check_summary_json",
          "base_ref",
          "head_ref",
          "closed_at",
          "merged_at",
        ])
      );

      // Tables that did not exist in the legacy database were created.
      expect(tableNames(db)).toContain("ai_summaries");
      expect(tableNames(db)).toContain("pull_request_check_runs");

      // The legacy table's own data path keeps working: the migration neither
      // dropped nor duplicated it.
      expect(
        (
          db
            .prepare(`select count(*) as n from sqlite_master where name = 'pull_requests'`)
            .get() as { n: number }
        ).n
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("re-runs the base-schema migration when its ledger row is removed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db);
      // Mimic the desktop's stale-cache recovery: drop a cache table and its
      // ledger row so the base-schema migration rebuilds it.
      db.exec(`drop table ai_summaries`);
      db.exec(`delete from schema_migrations where id = '0001-base-schema'`);

      const ran = applyMigrations(db);
      expect(ran).toEqual(["0001-base-schema"]);
      expect(tableNames(db)).toContain("ai_summaries");
    } finally {
      db.close();
    }
  });
});
