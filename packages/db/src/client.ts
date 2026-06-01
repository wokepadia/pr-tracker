import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

export async function createOrm(): Promise<MikroORM> {
  return MikroORM.init(config);
}
