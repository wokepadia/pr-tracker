import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { entities } from "./entities";

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/pr_tracker",
  entities,
  extensions: [Migrator],
  migrations: {
    path: "dist/migrations",
    pathTs: "src/migrations",
    tableName: "mikro_orm_migrations",
    transactional: true,
    allOrNothing: true,
    emit: "ts"
  }
});
