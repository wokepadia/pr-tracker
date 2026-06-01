import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

const orm = await MikroORM.init(config);

try {
  const migrator = orm.getMigrator();
  await migrator.up();
  console.log("Database migrations completed.");
} finally {
  await orm.close(true);
}
