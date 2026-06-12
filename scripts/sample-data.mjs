#!/usr/bin/env node
/**
 * Seeds or purges the demo reviewer inbox in a local Review Ninja SQLite
 * database. The app itself never touches sample data; this script is the
 * only way it enters or leaves a database.
 *
 * Usage:
 *   pnpm sample-data seed  [--db <path>]
 *   pnpm sample-data purge [--db <path>]
 *
 * Without --db the script uses PR_TRACKER_LOCAL_DB_PATH or the package
 * default (~/.pr-tracker/pr-tracker.sqlite). The desktop app's database
 * lives at:
 *   macOS: ~/Library/Application Support/dev.pr-tracker.desktop/pr-tracker.sqlite
 */
// Imported from source so the script never runs against a stale build.
import {
  defaultLocalDatabasePath,
  openLocalDatabase,
  removeLocalSampleData,
  seedLocalSampleData,
} from "../packages/db/src/local-sqlite.ts";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  let dbPath;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--db") {
      dbPath = rest[index + 1];
      index += 1;
    } else {
      return { error: `Unknown argument: ${rest[index]}` };
    }
  }
  return { command, dbPath };
}

const { command, dbPath, error } = parseArguments(process.argv.slice(2));
if (error || !["seed", "purge"].includes(command ?? "")) {
  if (error) console.error(error);
  console.error("Usage: pnpm sample-data <seed|purge> [--db <path>]");
  console.error(
    "Desktop app database (macOS): ~/Library/Application Support/dev.pr-tracker.desktop/pr-tracker.sqlite"
  );
  process.exit(2);
}

const path = dbPath ?? defaultLocalDatabasePath();
const local = openLocalDatabase({ path });
try {
  if (command === "seed") {
    seedLocalSampleData(local.db);
    console.log(`Seeded the sample reviewer inbox into ${path}`);
  } else {
    const { removedPullRequests } = removeLocalSampleData(local.db);
    console.log(
      removedPullRequests > 0
        ? `Removed ${removedPullRequests} sample pull requests from ${path}`
        : `No sample data found in ${path}`
    );
  }
} finally {
  local.close();
}
