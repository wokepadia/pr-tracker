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

  it("lists configured repository pull requests with reviews and changed files", async () => {
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

        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          return {
            data: [
              {
                filename: "apps/web/src/pages/InboxPage.tsx",
                additions: 12,
                deletions: 4
              }
            ] as T
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
        requested_reviewers: [{ login: "viewer" }]
      },
      changed_files: [
        {
          filename: "apps/web/src/pages/InboxPage.tsx",
          additions: 12,
          deletions: 4
        }
      ]
    });
    expect(calls.map((call) => call.route)).toContain(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files"
    );
  });
});
