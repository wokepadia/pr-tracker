import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createSampleRepository } from "./repository";
import { createMemoryWebhookSink } from "./webhook-sink";

describe("api app", () => {
  const app = createApp({
    repository: createSampleRepository(),
    webhookSink: createMemoryWebhookSink()
  });

  it("reports health", async () => {
    const response = await app.request("/health");
    const body = (await response.json()) as { ok: boolean; service: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "pr-tracker-api"
    });
  });

  it("serves the sample reviewer inbox", async () => {
    const response = await app.request("/api/reviewer-inbox");
    const body = (await response.json()) as {
      items: unknown[];
      sections: { needs_review: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(3);
    expect(body.sections.needs_review).toHaveLength(1);
  });

  it("serves pull request detail", async () => {
    const response = await app.request("/api/pull-requests/pr_3");
    const body = (await response.json()) as {
      item: {
        pullRequest: { id: string; title: string };
        workflowState: string;
      };
      viewer: { login: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      viewer: { login: "you" },
      item: {
        workflowState: "waiting_on_author",
        pullRequest: {
          id: "pr_3",
          title: "Handle duplicate webhook deliveries"
        }
      }
    });
  });

  it("updates sample last-seen state through the repository boundary", async () => {
    const seenResponse = await app.request("/api/pull-requests/pr_1/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastSeenAt: "2026-06-01T12:00:00.000Z" })
    });

    expect(seenResponse.status).toBe(200);

    const inboxResponse = await app.request("/api/reviewer-inbox");
    const inbox = (await inboxResponse.json()) as {
      items: Array<{ pullRequest: { id: string }; unseenActivityCount: number }>;
    };
    const item = inbox.items.find((entry) => entry.pullRequest.id === "pr_1");

    expect(item?.unseenActivityCount).toBe(0);

    const detailResponse = await app.request("/api/pull-requests/pr_1");
    const detail = (await detailResponse.json()) as {
      item: { pullRequest: { id: string }; unseenActivityCount: number };
    };

    expect(detailResponse.status).toBe(200);
    expect(detail.item).toMatchObject({
      pullRequest: { id: "pr_1" },
      unseenActivityCount: 0
    });
  });

  it("accepts unsigned local webhook payloads when GitHub env is absent", async () => {
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request"
      },
      body: JSON.stringify({
        action: "opened",
        installation: { id: 123 }
      })
    });
    const body = (await response.json()) as {
      accepted: boolean;
      event: { eventName: string; action?: string; installationId?: number };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      event: {
        eventName: "pull_request",
        action: "opened",
        installationId: 123
      },
      persistence: "memory"
    });
  });

  it("returns a retryable error when webhook persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    const failingApp = createApp({
      webhookSink: {
        async record() {
          throw new Error("database unavailable");
        }
      }
    });

    const response = await failingApp.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-2",
        "x-github-event": "pull_request"
      },
      body: JSON.stringify({ action: "synchronize" })
    });
    const body = (await response.json()) as {
      accepted: boolean;
      error: string;
    };

    expect(response.status).toBe(503);
    expect(body).toEqual({
      accepted: false,
      event: {
        action: "synchronize",
        deliveryId: "delivery-2",
        eventName: "pull_request",
        receivedAt: expect.any(String),
        rawPayload: { action: "synchronize" }
      },
      error: "Webhook persistence failed."
    });
    consoleError.mockRestore();
  });
});
