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

  it("paginates review threads across GraphQL pages", async () => {
    const cursors: Array<unknown> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
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
          const variables = parameters?.variables as { cursor?: string | null };
          cursors.push(variables.cursor);
          const isFirstPage = !variables.cursor;
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: isFirstPage
                        ? { hasNextPage: true, endCursor: "cursor-1" }
                        : { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: isFirstPage ? "RT_page1" : "RT_page2",
                          isResolved: false,
                          comments: { nodes: [] }
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

    if (!source.listOpenPullRequests) {
      throw new Error("Expected token source to support listOpenPullRequests.");
    }

    const snapshots = await source.listOpenPullRequests();

    expect(cursors).toEqual([null, "cursor-1"]);
    expect(snapshots[0]?.review_threads?.map((thread) => thread.id)).toEqual([
      "RT_page1",
      "RT_page2"
    ]);
  });

  it("maps the head commit status check rollup onto the snapshot", async () => {
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(route: string) => {
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
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    commits: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              state: "FAILURE",
                              contexts: { totalCount: 5 }
                            }
                          }
                        }
                      ]
                    },
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: []
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

    if (!source.listOpenPullRequests) {
      throw new Error("Expected token source to support listOpenPullRequests.");
    }

    const snapshots = await source.listOpenPullRequests();

    expect(snapshots[0]?.status_check_rollup).toEqual({
      state: "failure",
      total_count: 5
    });
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

  it("lists every open pull request across pages without duplicates", async () => {
    const listCalls: Array<Record<string, unknown> | undefined> = [];
    const openPage1 = Array.from({ length: 100 }, (_value, index) => ({
      id: index + 1,
      number: index + 1,
      title: `Open PR ${index + 1}`,
      state: "open",
      created_at: "2026-06-01T08:00:00.000Z",
      updated_at: "2026-06-01T09:00:00.000Z",
      user: { login: "author" }
    }));
    // Number 100 repeats on page 2, as happens when rows shift across
    // page boundaries between fetches.
    const openPage2 = [
      openPage1[99],
      {
        id: 101,
        number: 101,
        title: "Open PR 101",
        state: "open",
        created_at: "2026-06-02T08:00:00.000Z",
        updated_at: "2026-06-02T09:00:00.000Z",
        user: { login: "author" }
      }
    ];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        if (route === "GET /repos/{owner}/{repo}/pulls") {
          listCalls.push(parameters);
          return {
            data: (parameters?.page === 1 ? openPage1 : openPage2) as T
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

    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toMatchObject({
      state: "open",
      sort: "created",
      direction: "asc",
      page: 1
    });
    expect(snapshots).toHaveLength(101);
    expect(
      snapshots.filter((snapshot) => snapshot.pull_request.number === 100)
    ).toHaveLength(1);
  });

  it("keeps the newest snapshot when a pull request closes mid-listing", async () => {
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        if (route === "GET /repos/{owner}/{repo}/pulls") {
          if (parameters?.state === "open") {
            return {
              data: [
                {
                  id: 1,
                  number: 42,
                  title: "Still open when listed",
                  state: "open",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" }
                }
              ] as T
            };
          }

          return {
            data: [
              {
                id: 1,
                number: 42,
                title: "Merged moments later",
                state: "closed",
                updated_at: "2026-06-01T09:05:00.000Z",
                merged_at: "2026-06-01T09:05:00.000Z",
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

    if (!source.listPullRequests) {
      throw new Error("Expected token source to support listPullRequests.");
    }

    const snapshots = await source.listPullRequests();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.pull_request).toMatchObject({
      number: 42,
      state: "closed",
      merged: true,
      updated_at: "2026-06-01T09:05:00.000Z"
    });
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
      order: "desc",
      advanced_search: "true"
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reviews?.[0]?.body).toBeUndefined();
  });

  it("lists changed files with patches across pages", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      filename: `src/file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`
    }));
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        calls.push({ route, parameters });

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          if (parameters?.page === 1) {
            return { data: firstPage as T };
          }

          return {
            data: [
              {
                filename: "assets/logo.png",
                status: "added",
                additions: 0,
                deletions: 0
              }
            ] as T
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    const files = await source.listPullRequestChangedFiles({
      repository: "acme/web",
      number: 42
    });

    expect(files).toHaveLength(101);
    expect(files?.[0]).toEqual({
      path: "src/file-0.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-old-0\n+new-0"
    });
    expect(files?.[100]).toEqual({
      path: "assets/logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      patch: undefined
    });
    expect(
      calls.map((call) => call.parameters?.page)
    ).toEqual([1, 2]);
  });

  it("returns undefined changed files for repositories outside the allow list", async () => {
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async () => {
        throw new Error("Should not be called.");
      }
    });

    await expect(
      source.listPullRequestChangedFiles({ repository: "other/repo", number: 1 })
    ).resolves.toBeUndefined();
  });
});
