import { randomUUID } from "node:crypto";
import type { Transaction } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";

export interface PersistableWebhookDelivery {
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: number;
  receivedAt: string;
  rawPayload: unknown;
}

export async function recordWebhookDelivery(
  orm: MikroORM,
  delivery: PersistableWebhookDelivery,
  ctx?: Transaction
): Promise<"inserted_or_existing"> {
  await orm.em.getConnection().execute(
    `
      insert into webhook_deliveries (
        id,
        delivery_id,
        event_name,
        action,
        installation_id,
        received_at,
        raw_payload
      )
      values (?, ?, ?, ?, ?, ?, ?::jsonb)
      on conflict (delivery_id) do nothing
    `,
    [
      randomUUID(),
      delivery.deliveryId,
      delivery.eventName,
      delivery.action ?? null,
      delivery.installationId ?? null,
      delivery.receivedAt,
      JSON.stringify(delivery.rawPayload)
    ],
    undefined,
    ctx
  );

  return "inserted_or_existing";
}
