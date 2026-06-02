import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  getGithubAppEnv,
  normalizeWebhookEvent,
  verifyGithubWebhook
} from "@pr-tracker/github";
import { getApiConfig } from "./config";
import {
  createSampleRepository,
  shouldUseDatabaseRepository,
  type ReviewerInboxRepository
} from "./repository";
import { createWebhookSink, type WebhookSink } from "./webhook-sink";
import { createDatabaseRepository } from "./database-repository";

export function createApp(options?: {
  repository?: ReviewerInboxRepository;
  webhookSink?: WebhookSink;
}): Hono {
  const app = new Hono();
  const config = getApiConfig();
  const repository =
    options?.repository ??
    (shouldUseDatabaseRepository()
      ? createDatabaseRepository()
      : createSampleRepository());
  const webhookSink = options?.webhookSink ?? createWebhookSink();

  app.use(
    "*",
    cors({
      origin: config.WEB_ORIGIN,
      allowHeaders: ["content-type", "x-github-delivery", "x-github-event", "x-hub-signature-256"],
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"]
    })
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "pr-tracker-api",
      now: new Date().toISOString()
    })
  );

  app.get("/api/reviewer-inbox", async (c) => {
    return c.json(await repository.getReviewerInbox(new Date().toISOString()));
  });

  app.get("/api/pull-requests/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await repository.getPullRequest(id);

    if (!detail) {
      return c.json({ error: "Pull request not found." }, 404);
    }

    return c.json(detail);
  });

  app.post("/api/pull-requests/:id/seen", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const result = await repository.markSeen({
      pullRequestId: id,
      lastSeenAt:
        typeof body.lastSeenAt === "string"
          ? body.lastSeenAt
          : new Date().toISOString()
    });

    if (!result) {
      return c.json({ error: "Pull request not found." }, 404);
    }

    return c.json(result);
  });

  app.post("/webhooks/github", async (c) => {
    const githubEnv = getGithubAppEnv(process.env);
    const payloadText = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? null;

    if (githubEnv) {
      const verified = await verifyGithubWebhook({
        secret: githubEnv.GITHUB_WEBHOOK_SECRET,
        payload: payloadText,
        signature
      });

      if (!verified) {
        return c.json({ error: "Invalid webhook signature." }, 401);
      }
    }

    const payload = JSON.parse(payloadText || "{}") as unknown;
    const event = normalizeWebhookEvent({
      deliveryId: c.req.header("x-github-delivery") ?? "local-dev-delivery",
      eventName: c.req.header("x-github-event") ?? "unknown",
      payload
    });
    const persistenceResult = await webhookSink.record(event).then(
      (persistence) => ({ ok: true as const, persistence }),
      (error: unknown) => ({ ok: false as const, error })
    );

    if (!persistenceResult.ok) {
      console.error("Failed to persist webhook delivery.", persistenceResult.error);
      return c.json(
        {
          accepted: false,
          event,
          error: "Webhook persistence failed."
        },
        503
      );
    }

    return c.json({
      accepted: true,
      event,
      persistence: persistenceResult.persistence
    });
  });

  return app;
}
