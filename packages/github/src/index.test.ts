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
        requested_reviewers: [{ login: "viewer" }]
      }
    });
    expect(calls.map((call) => call.route)).not.toContain(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files"
    );
  });

  it("uses GitHub issue search syntax to list matching pull requests", async () => {
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
      q: "is:open assignee:@me is:pr repo:acme/web",
      sort: "updated",
      order: "desc"
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reviews?.[0]?.body).toBeUndefined();
  });
});
