import { describe, expect, it } from "vitest";
import {
  createGithubTokenPullRequestSource,
  parseGithubRepositories
} from "./index";

describe("GitHub token pull request source", () => {
  it("parses comma-separated repository allow lists", () => {
    expect(
      parseGithubRepositories("acme/web, acme/api, invalid, owner/repo ")
    ).toEqual(["acme/web", "acme/api", "owner/repo"]);
  });

  it("lists configured repository pull requests with reviews", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        calls.push({ route, parameters });

        if (route === "GET /user") {
          return { data: { login: "viewer" } as T };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls") {
          if (parameters?.state === "open") {
            return {
              data: [
                {
                  id: 1,
                  node_id: "PR_node_1",
                  number: 42,
                  title: "Ship reviewer inbox",
                  html_url: "https://github.com/acme/web/pull/42",
                  state: "open",
                  draft: false,
                  created_at: "2026-06-01T08:00:00.000Z",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" },
                  head: { sha: "head-sha" },
                  requested_reviewers: [{ login: "viewer" }]
                }
              ] as T
            };
          }

          return { data: [] as T };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return { data: [] as T };
        }

        if (route === "POST /graphql") {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    additions: 120,
                    deletions: 30,
                    changedFiles: 7,
                    reviewThreads: {
                      nodes: [
                        {
                          id: "RT_thread_1",
                          isResolved: false,
                          isOutdated: true,
                          path: "src/webhooks.ts",
                          line: 44,
                          comments: {
                            nodes: [
                              {
                                author: { login: "viewer" },
                                createdAt: "2026-06-01T08:30:00.000Z"
                              },
                              {
                                author: { login: "author" },
                                createdAt: "2026-06-01T09:00:00.000Z"
                              }
                            ]
                          }
                        }
                      ]
                    }
                  }
                }
              }
            } as T
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    await expect(source.getViewerLogin()).resolves.toBe("viewer");

    if (!source.listPullRequests) {
      throw new Error("Expected token source to support listPullRequests.");
    }

    const snapshots = await source.listPullRequests();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      repository: { full_name: "acme/web" },
      pull_request: {
        number: 42,
        requested_reviewers: [{ login: "viewer" }],
        additions: 120,
        deletions: 30,
        changed_files: 7
      }
    });
    expect(snapshots[0]?.review_threads).toEqual([
      {
        id: "RT_thread_1",
        is_resolved: false,
        is_outdated: true,
        path: "src/webhooks.ts",
        line: 44,
        comments: [
          {
            author: { login: "viewer" },
            created_at: "2026-06-01T08:30:00.000Z"
          },
          {
            author: { login: "author" },
            created_at: "2026-06-01T09:00:00.000Z"
          }
        ]
      }
    ]);
    const graphqlCall = calls.find((call) => call.route === "POST /graphql");
    expect(graphqlCall?.parameters).toMatchObject({
      variables: { owner: "acme", name: "web", number: 42 }
    });
    expect(calls.map((call) => call.route)).not.toContain(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files"
    );
  });

  it("keeps review threads undefined when the GraphQL fetch fails", async () => {
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        void parameters;

        if (route === "GET /repos/{owner}/{repo}/pulls") {
          return {
            data: [
              {
                id: 1,
                number: 42,
                title: "Ship reviewer inbox",
                state: "open",
                updated_at: "2026-06-01T09:00:00.000Z",
                user: { login: "author" }
              }
            ] as T
          };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return { data: [] as T };
        }

        if (route === "POST /graphql") {
          throw new Error("GraphQL unavailable");
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    if (!source.listOpenPullRequests) {
      throw new Error("Expected token source to support listOpenPullRequests.");
    }

    const snapshots = await source.listOpenPullRequests();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.review_threads).toBeUndefined();
  });

  it("uses GitHub issue search syntax to list matching pull requests", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web", "acme/api"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        calls.push({ route, parameters });

        if (route === "GET /search/issues") {
          return {
            data: {
              items: [
                {
                  number: 42,
                  repository_url: "https://api.github.com/repos/acme/web",
                  pull_request: {
                    url: "https://api.github.com/repos/acme/web/pulls/42"
                  }
                }
              ]
            } as T
          };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              number: 42,
              title: "Ship reviewer inbox",
              html_url: "https://github.com/acme/web/pull/42",
              state: "open",
              draft: false,
              created_at: "2026-06-01T08:00:00.000Z",
              updated_at: "2026-06-01T09:00:00.000Z",
              user: { login: "author" },
              head: { sha: "head-sha" }
            } as T
          };
        }

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return {
            data: [
              {
                id: 1,
                state: "APPROVED",
                body: "large review text",
                submitted_at: "2026-06-01T09:00:00.000Z",
                user: { login: "reviewer" }
              }
            ] as T
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    if (!source.listPullRequests) {
      throw new Error("Expected token source to support listPullRequests.");
    }

    const snapshots = await source.listPullRequests({
      searchQuery: "is:open assignee:@me"
    });
    const searchCall = calls.find((call) => call.route === "GET /search/issues");

    expect(searchCall?.parameters).toMatchObject({
      q: "is:open assignee:@me is:pr (repo:acme/web OR repo:acme/api)",
      sort: "updated",
      order: "desc"
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reviews?.[0]?.body).toBeUndefined();
  });
});
