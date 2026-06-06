import { Hono } from "hono";
import { cors } from "hono/cors";
import { normalizeWebhookEvent } from "@pr-tracker/github";
import { getApiConfig } from "./config";
import {
  getLocalGithubSettingsStatus,
  saveLocalGithubSettings,
  type LocalGithubSettingsOptions
} from "./local-github-settings";
import {
  getLocalOnboardingState,
  saveLocalOnboardingState,
  type LocalOnboardingSettingsOptions
} from "./local-onboarding-settings";
import {
  type BoardState,
  type ReviewerInboxRepository
} from "./repository";
import { createWebhookSink, type WebhookSink } from "./webhook-sink";
import { createConfiguredRepository } from "./configured-repository";

export function createApp(options?: {
  repository?: ReviewerInboxRepository;
  settingsOptions?: LocalGithubSettingsOptions;
  onboardingOptions?: LocalOnboardingSettingsOptions;
  webhookSink?: WebhookSink;
}): Hono {
  const app = new Hono();
  const config = getApiConfig();
  const repository =
    options?.repository ?? createConfiguredRepository(process.env, options?.settingsOptions);
  const webhookSink = options?.webhookSink ?? createWebhookSink();

  app.use(
    "*",
    cors({
      origin: config.WEB_ORIGIN,
      allowHeaders: ["content-type", "x-github-delivery", "x-github-event", "x-hub-signature-256"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"]
    })
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "pr-tracker-api",
      now: new Date().toISOString()
    })
  );

  app.get("/api/local-settings/github", async (c) => {
    try {
      return c.json(await getLocalGithubSettingsStatus(options?.settingsOptions));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load GitHub settings."
        },
        500
      );
    }
  });

  app.post("/api/local-settings/github", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      token?: unknown;
      repositories?: unknown;
      viewerLogin?: unknown;
      apiBaseUrl?: unknown;
    };

    try {
      const status = await saveLocalGithubSettings(
        {
          token: typeof body.token === "string" ? body.token : undefined,
          repositories:
            typeof body.repositories === "string" ||
            Array.isArray(body.repositories)
              ? body.repositories
              : "",
          viewerLogin:
            typeof body.viewerLogin === "string" ? body.viewerLogin : undefined,
          apiBaseUrl:
            typeof body.apiBaseUrl === "string" ? body.apiBaseUrl : undefined
        },
        options?.settingsOptions
      );

      return c.json(status);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to save GitHub settings."
        },
        400
      );
    }
  });

  app.get("/api/local-settings/onboarding", async (c) => {
    try {
      return c.json(await getLocalOnboardingState(options?.onboardingOptions));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load onboarding state."
        },
        500
      );
    }
  });

  app.post("/api/local-settings/onboarding", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      completedAt?: unknown;
      introSkippedAt?: unknown;
      version?: unknown;
      token?: unknown;
    };

    try {
      const state = await saveLocalOnboardingState(
        {
          completedAt:
            typeof body.completedAt === "string" ? body.completedAt : undefined,
          introSkippedAt:
            typeof body.introSkippedAt === "string"
              ? body.introSkippedAt
              : undefined,
          version: typeof body.version === "number" ? body.version : undefined
        },
        options?.onboardingOptions
      );

      return c.json(state);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to save onboarding state."
        },
        400
      );
    }
  });

  app.get("/api/reviewer-inbox", async (c) => {
    try {
      const rawGithubSearchQuery = c.req.query("githubSearchQuery");
      const githubSearchQuery = rawGithubSearchQuery?.trim();
      return c.json(
        await repository.getReviewerInbox(new Date().toISOString(), {
          githubSearchQuery: githubSearchQuery || undefined
        })
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load reviewer inbox."
        },
        502
      );
    }
  });

  app.get("/api/pull-requests/:id", async (c) => {
    const id = c.req.param("id");
    let detail: Awaited<ReturnType<ReviewerInboxRepository["getPullRequest"]>>;

    try {
      detail = await repository.getPullRequest(id);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load pull request."
        },
        502
      );
    }

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

  app.get("/api/board-state", async (c) => {
    if (!repository.getBoardState) {
      return c.json({ error: "Board state is not available." }, 501);
    }

    try {
      return c.json(await repository.getBoardState());
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to load board state."
        },
        502
      );
    }
  });

  app.put("/api/board-state", async (c) => {
    if (!repository.saveBoardState) {
      return c.json({ error: "Board state is not available." }, 501);
    }

    const body = await c.req.json().catch(() => undefined);
    if (!isBoardState(body)) {
      return c.json({ error: "Invalid board state." }, 400);
    }

    try {
      return c.json(await repository.saveBoardState(body));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to save board state."
        },
        502
      );
    }
  });

  app.post("/webhooks/github", async (c) => {
    const payloadText = await c.req.text();
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

function isBoardState(value: unknown): value is BoardState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<BoardState>;
  return (
    Array.isArray(candidate.buckets) &&
    isRecord(candidate.localQueueState) &&
    isRecord(candidate.userBucketItemOrder) &&
    isRecord(candidate.bucketColumnWidths)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
