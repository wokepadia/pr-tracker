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
                  labels: [
                    {
                      name: "bug",
                      color: "d73a4a",
                      description: "Something isn't working"
                    }
                  ],
                  assignees: [{ login: "author" }],
                  requested_reviewers: [{ login: "viewer" }]
                }
              ] as T
            };
          }

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
                    reviews: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          databaseId: 9001,
                          id: "PRR_node_9001",
                          state: "APPROVED",
                          submittedAt: "2026-06-01T09:10:00.000Z",
                          author: { login: "reviewer" },
                          commit: { oid: "head-sha" }
                        }
                      ]
                    },
                    comments: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          databaseId: 1001,
                          id: "IC_kw_1001",
                          author: { login: "author" },
                          body: "Top-level context for the reviewer.",
                          createdAt: "2026-06-01T08:45:00.000Z",
                          updatedAt: "2026-06-01T08:46:00.000Z",
                          url: "https://github.com/acme/web/pull/42#issuecomment-1001"
                        }
                      ]
                    },
                    timelineItems: {
                      nodes: [
                        {
                          createdAt: "2026-05-30T10:00:00.000Z",
                          requestedReviewer: { login: "viewer" }
                        },
                        {
                          createdAt: "2026-06-01T07:00:00.000Z",
                          requestedReviewer: { login: "viewer" }
                        },
                        { createdAt: "2026-05-29T10:00:00.000Z" }
                      ]
                    },
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
                                id: "PRRC_kw_1",
                                author: { login: "viewer" },
                                body: "Could this retry only 5xx responses?",
                                path: "src/webhooks.ts",
                                line: 44,
                                createdAt: "2026-06-01T08:30:00.000Z",
                                updatedAt: "2026-06-01T08:31:00.000Z",
                                url: "https://github.com/acme/web/pull/42#discussion_r1"
                              },
                              {
                                id: "PRRC_kw_2",
                                author: { login: "author" },
                                body: "I narrowed it to 5xx.",
                                path: "src/webhooks.ts",
                                line: 44,
                                createdAt: "2026-06-01T09:00:00.000Z",
                                updatedAt: "2026-06-01T09:01:00.000Z",
                                url: "https://github.com/acme/web/pull/42#discussion_r2"
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
        labels: [
          {
            name: "bug",
            color: "d73a4a",
            description: "Something isn't working"
          }
        ],
        assignees: [{ login: "author" }],
        additions: 120,
        deletions: 30,
        changed_files: 7
      }
    });
    expect(snapshots[0]?.review_requests).toEqual([
      { reviewer_login: "viewer", requested_at: "2026-06-01T07:00:00.000Z" }
    ]);
    expect(snapshots[0]?.review_threads).toEqual([
      {
        id: "RT_thread_1",
        is_resolved: false,
        is_outdated: true,
        path: "src/webhooks.ts",
        line: 44,
        comments: [
          {
            id: "PRRC_kw_1",
            author: { login: "viewer" },
            body: "Could this retry only 5xx responses?",
            path: "src/webhooks.ts",
            line: 44,
            created_at: "2026-06-01T08:30:00.000Z",
            updated_at: "2026-06-01T08:31:00.000Z",
            url: "https://github.com/acme/web/pull/42#discussion_r1"
          },
          {
            id: "PRRC_kw_2",
            author: { login: "author" },
            body: "I narrowed it to 5xx.",
            path: "src/webhooks.ts",
            line: 44,
            created_at: "2026-06-01T09:00:00.000Z",
            updated_at: "2026-06-01T09:01:00.000Z",
            url: "https://github.com/acme/web/pull/42#discussion_r2"
          }
        ]
      }
    ]);
    expect(snapshots[0]?.issue_comments).toEqual([
      {
        id: "IC_kw_1001",
        author: { login: "author" },
        body: "Top-level context for the reviewer.",
        created_at: "2026-06-01T08:45:00.000Z",
        updated_at: "2026-06-01T08:46:00.000Z",
        url: "https://github.com/acme/web/pull/42#issuecomment-1001"
      }
    ]);
    // Reviews are now sourced from the same GraphQL response with their bodies
    // stripped, in the REST review shape.
    expect(snapshots[0]?.reviews).toEqual([
      {
        id: 9001,
        node_id: "PRR_node_9001",
        state: "APPROVED",
        body: undefined,
        submitted_at: "2026-06-01T09:10:00.000Z",
        commit_id: "head-sha",
        user: { login: "reviewer" }
      }
    ]);
    const graphqlCall = calls.find((call) => call.route === "POST /graphql");
    expect(graphqlCall?.parameters).toMatchObject({
      variables: { owner: "acme", name: "web", number: 42 }
    });
    // The common case (<=100 reviews/comments) is a single GraphQL request: the
    // separate REST review and issue-comment endpoints are no longer called.
    expect(calls.map((call) => call.route)).not.toContain(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    );
    expect(calls.map((call) => call.route)).not.toContain(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
    );
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

  it("maps the review decision and individual check-run contexts", async () => {
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
                user: { login: "author" },
                head: { sha: "head-sha", ref: "feature/inbox" },
                base: { ref: "main" }
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
                    reviewDecision: "CHANGES_REQUESTED",
                    commits: {
                      nodes: [
                        {
                          commit: {
                            oid: "head-sha",
                            statusCheckRollup: {
                              state: "FAILURE",
                              contexts: {
                                totalCount: 2,
                                nodes: [
                                  {
                                    __typename: "CheckRun",
                                    id: "CR_1",
                                    name: "build",
                                    status: "COMPLETED",
                                    conclusion: "FAILURE",
                                    startedAt: "2026-06-01T08:50:00.000Z",
                                    completedAt: "2026-06-01T08:58:00.000Z",
                                    detailsUrl: "https://github.com/acme/web/runs/build",
                                    checkSuite: { app: { slug: "github-actions" } }
                                  },
                                  {
                                    __typename: "StatusContext",
                                    id: "SC_1",
                                    context: "ci/legacy",
                                    state: "SUCCESS",
                                    targetUrl: "https://legacy.example/status",
                                    createdAt: "2026-06-01T08:40:00.000Z"
                                  }
                                ]
                              }
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

    expect(snapshots[0]?.pull_request.head?.ref).toBe("feature/inbox");
    expect(snapshots[0]?.pull_request.base?.ref).toBe("main");
    expect(snapshots[0]?.review_decision).toBe("changes_requested");
    expect(snapshots[0]?.check_runs).toEqual([
      {
        id: "CR_1",
        name: "build",
        app_slug: "github-actions",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-06-01T08:50:00.000Z",
        completed_at: "2026-06-01T08:58:00.000Z",
        details_url: "https://github.com/acme/web/runs/build"
      },
      {
        id: "SC_1",
        name: "ci/legacy",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-01T08:40:00.000Z",
        details_url: "https://legacy.example/status"
      }
    ]);
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

        if (route === "POST /graphql") {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    reviews: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          databaseId: 1,
                          id: "PRR_node_1",
                          state: "APPROVED",
                          submittedAt: "2026-06-01T09:00:00.000Z",
                          author: { login: "reviewer" },
                          commit: { oid: "head-sha" }
                        }
                      ]
                    },
                    comments: {
                      totalCount: 0,
                      pageInfo: { hasNextPage: false },
                      nodes: []
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

  it("skips fetching searched pull requests unchanged since the last sync", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
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
                  updated_at: "2026-06-01T09:00:00.000Z",
                  pull_request: {
                    url: "https://api.github.com/repos/acme/web/pulls/42"
                  }
                }
              ]
            } as T
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    if (!source.listPullRequests) {
      throw new Error("Expected token source to support listPullRequests.");
    }

    // The stored version is at least as new as the search result, so the pull
    // request is unchanged and must not be re-fetched.
    const knownPullRequestVersions = new Map<string, string>([
      ["acme/web#42", "2026-06-01T09:00:00.000Z"]
    ]);
    const snapshots = await source.listPullRequests({
      searchQuery: "is:open assignee:@me",
      knownPullRequestVersions
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.unchanged).toBe(true);
    expect(snapshots[0]?.repository.full_name).toBe("acme/web");
    expect(snapshots[0]?.pull_request.number).toBe(42);
    // Only the search call was made; no per-PR detail or GraphQL hydration.
    expect(
      calls.some(
        (call) => call.route === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
      )
    ).toBe(false);
    expect(calls.some((call) => call.route === "POST /graphql")).toBe(false);
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

  it("skips hydration for pull requests unchanged since the last sync", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        calls.push({ route, parameters });

        if (route === "GET /repos/{owner}/{repo}/pulls") {
          if (parameters?.state === "open") {
            return {
              data: [
                {
                  id: 1,
                  number: 1,
                  title: "Unchanged since last sync",
                  state: "open",
                  // Same as the stored version below, so this PR is skipped.
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" }
                },
                {
                  id: 2,
                  number: 2,
                  title: "Updated since last sync",
                  state: "open",
                  // Newer than the stored version, so this PR is hydrated.
                  updated_at: "2026-06-02T09:00:00.000Z",
                  user: { login: "author" }
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
                    additions: 1,
                    deletions: 0,
                    changedFiles: 1,
                    timelineItems: { nodes: [] },
                    reviewThreads: { nodes: [] }
                  }
                }
              }
            } as T
          };
        }

        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
          return { data: [] as T };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    if (!source.listPullRequests) {
      throw new Error("Expected token source to support listPullRequests.");
    }

    const knownPullRequestVersions = new Map<string, string>([
      ["acme/web#1", "2026-06-01T09:00:00.000Z"],
      ["acme/web#2", "2026-06-01T09:00:00.000Z"]
    ]);
    const snapshots = await source.listPullRequests({ knownPullRequestVersions });

    expect(snapshots).toHaveLength(2);

    const unchanged = snapshots.find(
      (snapshot) => snapshot.pull_request.number === 1
    );
    expect(unchanged?.unchanged).toBe(true);
    // The unchanged snapshot carries identity fields but no hydrated data, so
    // upsert leaves the existing row's reviews/threads/comments untouched.
    expect(unchanged?.reviews).toBeUndefined();
    expect(unchanged?.review_threads).toBeUndefined();
    expect(unchanged?.issue_comments).toBeUndefined();
    expect(unchanged?.pull_request.merged).toBe(false);

    const hydrated = snapshots.find(
      (snapshot) => snapshot.pull_request.number === 2
    );
    expect(hydrated?.unchanged).toBeUndefined();
    expect(hydrated?.reviews).toBeDefined();

    // No per-PR hydration request was made for the unchanged PR #1, while PR #2
    // received its reviews + GraphQL + issue-comment requests.
    const hydrationRoutes = new Set([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      "POST /graphql",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
    ]);
    const hydrationCalls = calls.filter((call) => hydrationRoutes.has(call.route));
    expect(
      hydrationCalls.every(
        (call) =>
          call.parameters?.pull_number === 2 ||
          call.parameters?.issue_number === 2 ||
          (call.route === "POST /graphql" &&
            (call.parameters as { variables?: { number?: number } })?.variables
              ?.number === 2)
      )
    ).toBe(true);
    // PR #1 specifically must not have hit any hydration route.
    expect(
      calls.some(
        (call) =>
          call.parameters?.pull_number === 1 || call.parameters?.issue_number === 1
      )
    ).toBe(false);
  });

  it("falls back to the REST helpers when reviews or comments overflow the GraphQL page", async () => {
    const calls: Array<{ route: string; parameters?: Record<string, unknown> }> = [];
    const source = createGithubTokenPullRequestSource({
      token: "token",
      repositories: ["acme/web"],
      request: async <T = unknown>(
        route: string,
        parameters?: Record<string, unknown>
      ) => {
        calls.push({ route, parameters });

        if (route === "GET /repos/{owner}/{repo}/pulls") {
          if (parameters?.state === "open") {
            return {
              data: [
                {
                  id: 1,
                  number: 42,
                  title: "Very chatty pull request",
                  state: "open",
                  updated_at: "2026-06-01T09:00:00.000Z",
                  user: { login: "author" }
                }
              ] as T
            };
          }

          return { data: [] as T };
        }

        if (route === "POST /graphql") {
          return {
            data: {
              data: {
                repository: {
                  pullRequest: {
                    // hasNextPage true means the first page is truncated, so
                    // these in-band nodes must be discarded in favor of the
                    // complete REST list below.
                    reviews: {
                      totalCount: 150,
                      pageInfo: { hasNextPage: true },
                      nodes: [
                        {
                          databaseId: 1,
                          id: "PRR_graphql_only",
                          state: "COMMENTED",
                          submittedAt: "2026-06-01T08:00:00.000Z",
                          author: { login: "reviewer" }
                        }
                      ]
                    },
                    comments: {
                      totalCount: 120,
                      pageInfo: { hasNextPage: true },
                      nodes: [
                        {
                          databaseId: 5,
                          id: "IC_graphql_only",
                          author: { login: "author" },
                          body: "graphql-only comment",
                          createdAt: "2026-06-01T08:00:00.000Z",
                          updatedAt: null,
                          url: "https://github.com/acme/web/pull/42#graphql"
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

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return {
            data: [
              {
                id: 7001,
                node_id: "PRR_rest_7001",
                state: "APPROVED",
                body: "rest review body",
                submitted_at: "2026-06-01T09:00:00.000Z",
                commit_id: "rest-sha",
                user: { login: "rest-reviewer" }
              }
            ] as T
          };
        }

        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
          return {
            data: [
              {
                id: 8001,
                node_id: "IC_rest_8001",
                body: "rest comment body",
                html_url: "https://github.com/acme/web/pull/42#rest",
                created_at: "2026-06-01T09:30:00.000Z",
                updated_at: "2026-06-01T09:31:00.000Z",
                user: { login: "author" }
              }
            ] as T
          };
        }

        throw new Error(`Unexpected route: ${route}`);
      }
    });

    if (!source.listOpenPullRequests) {
      throw new Error("Expected token source to support listOpenPullRequests.");
    }

    const snapshots = await source.listOpenPullRequests();

    // The REST fallbacks fired and their complete lists won over the truncated
    // GraphQL nodes.
    expect(calls.map((call) => call.route)).toContain(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
    );
    expect(calls.map((call) => call.route)).toContain(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"
    );
    expect(snapshots[0]?.reviews).toEqual([
      {
        id: 7001,
        node_id: "PRR_rest_7001",
        state: "APPROVED",
        // Bodies are stripped on the configured-repo path even for the
        // fallback list.
        body: undefined,
        submitted_at: "2026-06-01T09:00:00.000Z",
        commit_id: "rest-sha",
        user: { login: "rest-reviewer" }
      }
    ]);
    expect(snapshots[0]?.issue_comments).toEqual([
      {
        id: "IC_rest_8001",
        author: { login: "author" },
        body: "rest comment body",
        created_at: "2026-06-01T09:30:00.000Z",
        updated_at: "2026-06-01T09:31:00.000Z",
        url: "https://github.com/acme/web/pull/42#rest"
      }
    ]);
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
