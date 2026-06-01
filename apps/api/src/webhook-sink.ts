import type { NormalizedWebhookEvent } from "@pr-tracker/github";
import {
  createOrm,
  ingestWebhookEvent,
  recordWebhookDelivery
} from "@pr-tracker/db";

export interface WebhookSink {
  record(event: NormalizedWebhookEvent): Promise<string>;
}

export function createMemoryWebhookSink(): WebhookSink {
  const deliveryIds = new Set<string>();

  return {
    async record(event) {
      deliveryIds.add(event.deliveryId);
      return "memory";
    }
  };
}

export function createWebhookSink(): WebhookSink {
  if (process.env.PR_TRACKER_USE_DATABASE !== "true") {
    return createMemoryWebhookSink();
  }

  let ormPromise: ReturnType<typeof createOrm> | undefined;

  return {
    async record(event) {
      ormPromise ??= createOrm();
      const orm = await ormPromise;

      await orm.em.getConnection().transactional(async (trx) => {
        await recordWebhookDelivery(orm, event, trx);
        await ingestWebhookEvent(orm, event, trx);
      });
      return "database";
    }
  };
}
