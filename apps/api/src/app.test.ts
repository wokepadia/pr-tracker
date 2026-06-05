import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createGithubLiveRepository } from "./github-live-repository";
import { createMemoryGithubSettingsStore } from "./local-github-settings";
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
      items: Array<{
        pullRequest: {
          id: string;
        };
      }>;
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
      items: Array<{
        pullRequest: { id: string };
        workflowState: string;
        unseenActivityCount: number;
      }>;
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

  it("moves changed-after-review items to caught up when marked seen", async () => {
    const seenResponse = await app.request("/api/pull-requests/pr_2/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastSeenAt: "2026-06-01T12:00:00.000Z" })
    });

    expect(seenResponse.status).toBe(200);

    const inboxResponse = await app.request("/api/reviewer-inbox");
    const inbox = (await inboxResponse.json()) as {
      items: Array<{
        pullRequest: { id: string };
        workflowState: string;
        unseenActivityCount: number;
      }>;
    };
    const item = inbox.items.find((entry) => entry.pullRequest.id === "pr_2");

    expect(item).toMatchObject({
      pullRequest: { id: "pr_2" },
      workflowState: "caught_up",
      unseenActivityCount: 0
    });
  });

  it("does not create caught-up state for unknown pull requests", async () => {
    const seenResponse = await app.request("/api/pull-requests/missing/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastSeenAt: "2026-06-01T12:00:00.000Z" })
    });
    const body = await seenResponse.json();

    expect(seenResponse.status).toBe(404);
    expect(body).toEqual({ error: "Pull request not found." });
  });

  it("stores local GitHub settings without returning the token", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "pr-tracker-settings-")),
      "github-settings.json"
    );
    const store = createMemoryGithubSettingsStore();
    const app = createApp({
      repository: createSampleRepository(),
      settingsOptions: { configPath, store },
      webhookSink: createMemoryWebhookSink()
    });

    const saveResponse = await app.request("/api/local-settings/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "github_pat_read_only",
        repositories: "zulip/zulip, invalid",
        viewerLogin: "reviewer"
      })
    });
    const saveBody = (await saveResponse.json()) as {
      repositories: string[];
      viewerLogin?: string;
      token?: string;
      tokenConfigured: boolean;
    };

    expect(saveResponse.status).toBe(200);
    expect(saveBody).toEqual({
      repositories: ["zulip/zulip"],
      viewerLogin: "reviewer",
      tokenConfigured: true,
      storage: "macos-keychain"
    });
    expect(saveBody.token).toBeUndefined();
    await expect(store.readToken()).resolves.toBe("github_pat_read_only");

    const statusResponse = await app.request("/api/local-settings/github");
    const statusBody = await statusResponse.json();

    expect(statusResponse.status).toBe(200);
    expect(statusBody).toEqual(saveBody);
  });

  it("passes reviewer inbox GitHub search query overrides through the repository boundary", async () => {
    let seenSearchQuery: string | undefined;
    const app = createApp({
      repository: {
        async getReviewerInbox(now, options) {
          seenSearchQuery = options?.githubSearchQuery;
          return createSampleRepository().getReviewerInbox(now);
        },
        async getPullRequest() {
          return undefined;
        },
        async markSeen() {
          return undefined;
        }
      },
      webhookSink: createMemoryWebhookSink()
    });

    const response = await app.request(
      "/api/reviewer-inbox?githubSearchQuery=is%3Aopen%20assignee%3A%40me"
    );

    expect(response.status).toBe(200);
    expect(seenSearchQuery).toBe("is:open assignee:@me");
  });

  it("serves reviewer inbox data from a live GitHub source", async () => {
    const app = createApp({
      repository: createGithubLiveRepository({
        source: {
          async getViewerLogin() {
            return "viewer";
          },
          async listPullRequests() {
            return [
              {
                repository: { full_name: "acme/web" },
                pull_request: {
                  number: 42,
                  title: "Ship reviewer inbox",
                  body: "Adds the reviewer inbox surface for local use.",
                  html_url: "https://github.com/acme/web/pull/42",
                  state: "open",
                  draft: false,
                  created_at: "2026-06-01T08:00:00.000Z",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: {
                    login: "author",
                    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
                  },
                  head: { sha: "head-sha" },
                  requested_reviewers: [{ login: "viewer" }]
                },
                reviews: []
              }
            ];
          }
        }
      }),
      webhookSink: createMemoryWebhookSink()
    });

    const response = await app.request("/api/reviewer-inbox");
    const body = (await response.json()) as {
      viewer: { login: string };
      actors: Array<{ login: string; avatarUrl?: string }>;
      items: Array<{
        workflowState: string;
        pullRequest: {
          id: string;
          repository: string;
          description?: string;
          activity: Array<{ title: string; url?: string; diffUrl?: string }>;
        };
      }>;
      sections: { needs_review: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.viewer.login).toBe("viewer");
    expect(body.actors.find((actor) => actor.login === "author")).toMatchObject({
      login: "author",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      workflowState: "needs_review",
      pullRequest: {
        id: "github:acme~web:42",
        repository: "acme/web",
        description: "Adds the reviewer inbox surface for local use.",
        activity: expect.arrayContaining([
          expect.objectContaining({
            title: "author updated this pull request",
            url: "https://github.com/acme/web/pull/42",
            diffUrl: "https://github.com/acme/web/pull/42/files"
          })
        ])
      }
    });
    expect(body.sections.needs_review).toHaveLength(1);
  });

  it("persists live GitHub last-seen state for the local API process", async () => {
    const app = createApp({
      repository: createGithubLiveRepository({
        viewerLogin: "viewer",
        source: {
          async listPullRequests() {
            return [
              {
                repository: { full_name: "acme/api" },
                pull_request: {
                  number: 7,
                  title: "Handle requested changes",
                  html_url: "https://github.com/acme/api/pull/7",
                  state: "open",
                  draft: false,
                  created_at: "2026-06-01T08:00:00.000Z",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" },
                  head: { sha: "new-sha" },
                  requested_reviewers: []
                },
                reviews: [
                  {
                    id: 1,
                    state: "CHANGES_REQUESTED",
                    submitted_at: "2026-06-01T08:30:00.000Z",
                    commit_id: "old-sha",
                    user: { login: "viewer" }
                  }
                ]
              }
            ];
          }
        }
      }),
      webhookSink: createMemoryWebhookSink()
    });

    const seenResponse = await app.request(
      "/api/pull-requests/github:acme~api:7/seen",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lastSeenAt: "2026-06-01T12:00:00.000Z" })
      }
    );

    expect(seenResponse.status).toBe(200);

    const inboxResponse = await app.request("/api/reviewer-inbox");
    const inbox = (await inboxResponse.json()) as {
      items: Array<{
        workflowState: string;
        unseenActivityCount: number;
        pullRequest: { id: string };
      }>;
    };

    expect(inbox.items[0]).toMatchObject({
      pullRequest: { id: "github:acme~api:7" },
      workflowState: "caught_up",
      unseenActivityCount: 0
    });
  });

  it("serves live GitHub pull request details by encoded pull request id", async () => {
    const app = createApp({
      repository: createGithubLiveRepository({
        viewerLogin: "viewer",
        source: {
          async listPullRequests() {
            return [];
          },
          async getPullRequest(input) {
            expect(input).toEqual({ repository: "acme/api", number: 7 });
            return {
              repository: { full_name: "acme/api" },
              pull_request: {
                number: 7,
                title: "Handle requested changes",
                body: "Explains why the requested changes matter.",
                html_url: "https://github.com/acme/api/pull/7",
                state: "open",
                draft: false,
                created_at: "2026-06-01T08:00:00.000Z",
                updated_at: "2026-06-01T09:00:00.000Z",
                user: { login: "author" },
                head: { sha: "new-sha" },
                requested_reviewers: ["viewer"].map((login) => ({ login }))
              },
              reviews: []
            };
          }
        }
      }),
      webhookSink: createMemoryWebhookSink()
    });

    const response = await app.request(
      "/api/pull-requests/github:acme~api:7"
    );
    const body = (await response.json()) as {
      item: {
        pullRequest: {
          id: string;
          description?: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.item.pullRequest).toMatchObject({
      id: "github:acme~api:7",
      description: "Explains why the requested changes matter."
    });
  });

  it("accepts unsigned local webhook payloads when GitHub env is absent", async () => {
    const response = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request"
      },
      body: JSON.stringify({ action: "opened" })
    });
    const body = (await response.json()) as {
      accepted: boolean;
      event: { eventName: string; action?: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      event: {
        eventName: "pull_request",
        action: "opened"
      },
      persistence: "memory"
    });
  });

  it("returns a retryable error when webhook persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    const failingApp = createApp({
      repository: createSampleRepository(),
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
