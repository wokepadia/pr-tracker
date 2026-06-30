import type { DatabaseSync } from "node:sqlite";
import { localDesktopSchemaSql } from "./local-schema";

/**
 * Versioned, idempotent schema migrations shared by both ingestion paths:
 * the synchronous `node:sqlite` path in `local-sqlite.ts` (tests, scripts) and
 * the asynchronous Tauri SQL-plugin path in the desktop app.
 *
 * Migrations are declared as data — a list of operations — so the one list can
 * be replayed by both a synchronous and an asynchronous interpreter. Every
 * operation is written to be safe to re-run: `exec` statements use
 * `create ... if not exists`, and `addColumn` checks the live table shape
 * before altering. That idempotence is deliberate: real databases already
 * exist in the field with tables created by the historical
 * create-if-not-exists path and no migration ledger, so the first run of the
 * ledger replays every migration and each operation simply no-ops wherever the
 * state already matches.
 */

export type MigrationOp =
  | { kind: "exec"; sql: string }
  | { kind: "addColumn"; table: string; column: string; definition: string };

export interface Migration {
  id: string;
  ops: MigrationOp[];
}

const createSchemaMigrationsSql = `
  create table if not exists schema_migrations (
    id text primary key,
    applied_at text not null default current_timestamp
  )
`;

export const migrations: Migration[] = [
  {
    // The full base schema. create-if-not-exists makes this a no-op for any
    // database that already has the tables.
    id: "0001-base-schema",
    ops: splitSqlStatements(localDesktopSchemaSql).map((sql) => ({
      kind: "exec",
      sql,
    })),
  },
  {
    // Private per-PR notes arrived after the original board_items shape.
    id: "0002-board-item-notes",
    ops: [
      { kind: "addColumn", table: "board_items", column: "notes", definition: "text" },
    ],
  },
  {
    // The review-thread ledger gained an outdated flag and a last-actor login.
    id: "0003-review-thread-ledger",
    ops: [
      {
        kind: "addColumn",
        table: "review_threads",
        column: "is_outdated",
        definition: "integer not null default 0",
      },
      {
        kind: "addColumn",
        table: "review_threads",
        column: "last_actor_login",
        definition: "text",
      },
    ],
  },
  {
    // Diff-size facts on the pull request row.
    id: "0004-pull-request-size",
    ops: [
      { kind: "addColumn", table: "pull_requests", column: "additions", definition: "integer" },
      { kind: "addColumn", table: "pull_requests", column: "deletions", definition: "integer" },
      {
        kind: "addColumn",
        table: "pull_requests",
        column: "changed_files",
        definition: "integer",
      },
    ],
  },
  {
    // Merge/branch facts and the status-check rollup summary. All present in the
    // current base schema, so this only touches databases predating them.
    id: "0005-pull-request-merge-and-refs",
    ops: [
      { kind: "addColumn", table: "pull_requests", column: "mergeable_state", definition: "text" },
      { kind: "addColumn", table: "pull_requests", column: "review_decision", definition: "text" },
      {
        kind: "addColumn",
        table: "pull_requests",
        column: "status_check_summary_json",
        definition: "text not null default '{}'",
      },
      { kind: "addColumn", table: "pull_requests", column: "base_ref", definition: "text" },
      { kind: "addColumn", table: "pull_requests", column: "head_ref", definition: "text" },
      { kind: "addColumn", table: "pull_requests", column: "closed_at", definition: "text" },
      { kind: "addColumn", table: "pull_requests", column: "merged_at", definition: "text" },
    ],
  },
  {
    // Persisted dashboard chat conversations.
    id: "0006-chat",
    ops: [
      {
        kind: "exec",
        sql: `
          create table if not exists chat_threads (
            id text primary key,
            board_fingerprint text not null,
            title text,
            created_at text not null default current_timestamp,
            updated_at text not null default current_timestamp,
            archived_at text
          )
        `,
      },
      {
        kind: "exec",
        sql: `
          create index if not exists chat_threads_board_idx
            on chat_threads (board_fingerprint, archived_at, updated_at desc)
        `,
      },
      {
        kind: "exec",
        sql: `
          create table if not exists chat_messages (
            id text primary key,
            thread_id text not null references chat_threads(id) on delete cascade,
            role text not null,
            content text not null,
            model text,
            created_at text not null default current_timestamp,
            check (role in ('user', 'assistant', 'system'))
          )
        `,
      },
      {
        kind: "exec",
        sql: `
          create index if not exists chat_messages_thread_idx
            on chat_messages (thread_id, created_at)
        `,
      },
    ],
  },
  {
    // Per-card AI dashboard summaries, enabling incremental regeneration: only
    // cards whose fingerprint changed are re-sent to the model.
    id: "0007-ai-dashboard-cards",
    ops: [
      {
        kind: "exec",
        sql: `
          create table if not exists ai_dashboard_cards (
            pull_request_id text primary key,
            fingerprint text not null,
            model text not null,
            user_card_json text not null,
            machine_summary text not null,
            generated_at text not null default current_timestamp
          )
        `,
      },
    ],
  },
];

/**
 * Applies all unapplied migrations to a synchronous `node:sqlite` database and
 * returns the ids that ran this call.
 */
export function applyMigrations(db: DatabaseSync): string[] {
  db.exec(createSchemaMigrationsSql);
  const applied = new Set(
    (db.prepare(`select id from schema_migrations`).all() as Array<{ id: string }>).map(
      (row) => row.id
    )
  );

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    for (const op of migration.ops) {
      applySyncOp(db, op);
    }
    db.prepare(`insert into schema_migrations (id) values (?)`).run(migration.id);
    ran.push(migration.id);
  }
  return ran;
}

function applySyncOp(db: DatabaseSync, op: MigrationOp): void {
  if (op.kind === "exec") {
    db.exec(op.sql);
    return;
  }

  if (!syncTableExists(db, op.table)) {
    return;
  }
  const columns = db
    .prepare(`pragma table_info(${op.table})`)
    .all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === op.column)) {
    return;
  }
  db.exec(`alter table ${op.table} add column ${op.column} ${op.definition}`);
}

function syncTableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`select 1 as present from sqlite_master where type = 'table' and name = ?`)
    .get(table) as { present: number } | undefined;
  return Boolean(row);
}

/**
 * Driver an asynchronous database (the Tauri SQL plugin) exposes to the
 * migration runner. Kept minimal so the desktop can supply it from its own
 * `execute`/`select` wrappers without leaking the runner's internals.
 */
export interface AsyncMigrationDriver {
  exec(sql: string): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
}

/**
 * Applies all unapplied migrations through an asynchronous driver and returns
 * the ids that ran this call. Mirrors {@link applyMigrations} exactly so both
 * ingestion paths converge on the same schema.
 */
export async function applyMigrationsAsync(
  driver: AsyncMigrationDriver
): Promise<string[]> {
  await driver.exec(createSchemaMigrationsSql);
  const appliedRows = await driver.query<{ id: string }>(
    `select id from schema_migrations`
  );
  const applied = new Set(appliedRows.map((row) => row.id));

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    for (const op of migration.ops) {
      await applyAsyncOp(driver, op);
    }
    await driver.exec(
      `insert into schema_migrations (id) values (${sqlStringLiteral(migration.id)})`
    );
    ran.push(migration.id);
  }
  return ran;
}

async function applyAsyncOp(
  driver: AsyncMigrationDriver,
  op: MigrationOp
): Promise<void> {
  if (op.kind === "exec") {
    await driver.exec(op.sql);
    return;
  }

  const tablePresence = await driver.query<{ present: number }>(
    `select 1 as present from sqlite_master where type = 'table' and name = ${sqlStringLiteral(
      op.table
    )}`
  );
  if (tablePresence.length === 0) {
    return;
  }
  const columns = await driver.query<{ name: string }>(
    `pragma table_info(${op.table})`
  );
  if (columns.some((column) => column.name === op.column)) {
    return;
  }
  await driver.exec(
    `alter table ${op.table} add column ${op.column} ${op.definition}`
  );
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
