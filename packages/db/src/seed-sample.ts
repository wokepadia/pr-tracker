import { createOrm } from "./client";
import { seedSampleData } from "./sample-data";

const orm = await createOrm();

try {
  await seedSampleData(orm);
  console.log("Sample data seeded.");
} finally {
  await orm.close(true);
}
