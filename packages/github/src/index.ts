import { z } from "zod";

export const githubTokenEnvSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORIES: z.string().min(1),
  GITHUB_API_BASE_URL: z.string().url().optional()
});

export type GithubTokenEnv = z.infer<typeof githubTokenEnvSchema>;

export function getGithubTokenEnv(
  env: Record<string, string | undefined>
): GithubTokenEnv | undefined {
  const result = githubTokenEnvSchema.safeParse(env);
  return result.success ? result.data : undefined;
}

export interface NormalizedWebhookEvent {
  deliveryId: string;
  eventName: string;
  action?: string;
  receivedAt: string;
  rawPayload: unknown;
}

export function normalizeWebhookEvent(input: {
  deliveryId: string;
  eventName: string;
  payload: unknown;
  receivedAt?: string;
}): NormalizedWebhookEvent {
  const payload = input.payload as { action?: string };

  return {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    action: payload.action,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    rawPayload: input.payload
  };
}

export interface GitHubPullRequestSnapshot {
  repository: {
    full_name: string;
    html_url?: string;
    owner?: { login?: string };
  };
  pull_request: {
    id?: number;
    node_id?: string;
    number?: number;
    title?: string;
    html_url?: string;
    state?: string;
    draft?: boolean;
    created_at?: string;
    updated_at?: string;
    user?: { login?: string };
    head?: { sha?: string };
    merged?: boolean;
    requested_reviewers?: Array<{ login?: string }>;
  };
  reviews?: GitHubReviewSnapshot[];
  changed_files?: GitHubChangedFileSnapshot[];
}

export interface GitHubReviewSnapshot {
  id: number;
  node_id?: string;
  state?: string;
  body?: string | null;
  submitted_at?: string;
  commit_id?: string;
  user?: { login?: string };
}

export interface GitHubChangedFileSnapshot {
  filename: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  status?: string;
  patch?: string;
}

export interface GitHubPullRequestLookupInput {
  repository: string;
  number: number;
}

interface GitHubPullRequestLookupSource {
  getPullRequest?(
    input: GitHubPullRequestLookupInput
  ): Promise<GitHubPullRequestSnapshot | undefined>;
}

export type GitHubPullRequestSource =
  | (GitHubPullRequestLookupSource & {
      listPullRequests(): Promise<GitHubPullRequestSnapshot[]>;
      listOpenPullRequests?: () => Promise<GitHubPullRequestSnapshot[]>;
    })
  | (GitHubPullRequestLookupSource & {
      listPullRequests?: () => Promise<GitHubPullRequestSnapshot[]>;
      listOpenPullRequests(): Promise<GitHubPullRequestSnapshot[]>;
    });

interface RequestingOctokit {
  request<T = unknown>(
    route: string,
    parameters?: Record<string, unknown>
  ): Promise<{ data: T }>;
}

interface GitHubRepositoryFromApi {
  full_name: string;
  html_url?: string;
  owner?: { login?: string };
}

interface GitHubPullRequestFromApi {
  id: number;
  node_id?: string;
  number: number;
  title: string;
  html_url?: string;
  state?: string;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string };
  head?: { sha?: string };
  merged?: boolean;
  merged_at?: string | null;
  requested_reviewers?: Array<{ login?: string }>;
}

interface GitHubReviewFromApi {
  id: number;
  node_id?: string;
  state?: string;
  body?: string | null;
  submitted_at?: string;
  commit_id?: string;
  user?: { login?: string };
}

interface GitHubChangedFileFromApi {
  filename: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  status?: string;
  patch?: string;
}

interface GitHubUserFromApi {
  login: string;
}

export function createGithubTokenPullRequestSource(input: {
  token: string;
  repositories: string[];
  apiBaseUrl?: string;
  closedLookbackDays?: number;
  request?: RequestingOctokit["request"];
}): GitHubPullRequestSource & { getViewerLogin(): Promise<string> } {
  const octokit: RequestingOctokit = {
    request:
      input.request ??
      createTokenRequest({
        token: input.token,
        apiBaseUrl: input.apiBaseUrl
      })
  };

  return {
    async getViewerLogin() {
      const response = await octokit.request<GitHubUserFromApi>("GET /user");
      return response.data.login;
    },
    async listPullRequests() {
      return listConfiguredRepositoryPullRequests(octokit, input.repositories, {
        includeRecentClosed: true,
        closedLookbackDays: input.closedLookbackDays
      });
    },
    async listOpenPullRequests() {
      return listConfiguredRepositoryPullRequests(octokit, input.repositories, {
        includeRecentClosed: false,
        closedLookbackDays: input.closedLookbackDays
      });
    },
    async getPullRequest(lookup) {
      if (!input.repositories.includes(lookup.repository)) {
        return undefined;
      }

      return getTokenPullRequest(octokit, lookup);
    }
  };
}

export function parseGithubRepositories(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((repository) => repository.trim())
    .filter((repository) => /^[^/\s]+\/[^/\s]+$/.test(repository));
}

export function getGithubClosedLookbackDays(
  env: Record<string, string | undefined>
): number | undefined {
  const raw = env.GITHUB_CLOSED_LOOKBACK_DAYS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function listConfiguredRepositoryPullRequests(
  octokit: RequestingOctokit,
  repositories: string[],
  options: {
    includeRecentClosed: boolean;
    closedLookbackDays?: number;
  }
): Promise<GitHubPullRequestSnapshot[]> {
  const snapshots: GitHubPullRequestSnapshot[] = [];
  const closedUpdatedSince = new Date(
    Date.now() - (options.closedLookbackDays ?? 30) * 24 * 60 * 60 * 1000
  ).toISOString();

  for (const repository of repositories) {
    const [owner, name] = repository.split("/");
    if (!owner || !name) {
      continue;
    }

    const openPullRequests = await listRepoPullRequests(octokit, owner, name, {
      state: "open"
    });
    const recentlyClosedPullRequests = options.includeRecentClosed
      ? await listRepoPullRequests(octokit, owner, name, {
          state: "closed",
          updatedSince: closedUpdatedSince
        })
      : [];

    for (const pullRequest of [
      ...openPullRequests,
      ...recentlyClosedPullRequests
    ]) {
      const [reviews, changedFiles] = await Promise.all([
        listPullRequestReviews(octokit, owner, name, pullRequest.number),
        listPullRequestFiles(octokit, owner, name, pullRequest.number)
      ]);

      snapshots.push({
        repository: {
          full_name: repository,
          html_url: `https://github.com/${repository}`,
          owner: { login: owner }
        },
        pull_request: {
          ...pullRequest,
          merged: pullRequest.merged ?? Boolean(pullRequest.merged_at)
        },
        reviews,
        changed_files: changedFiles
      });
    }
  }

  return snapshots;
}

async function listRepoPullRequests(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  options: {
    state: "open" | "closed";
    updatedSince?: string;
  }
): Promise<GitHubPullRequestFromApi[]> {
  const pullRequests: GitHubPullRequestFromApi[] = [];
  const updatedSinceTime = options.updatedSince
    ? Date.parse(options.updatedSince)
    : undefined;

  for (let page = 1; ; page += 1) {
    const response = await octokit.request<GitHubPullRequestFromApi[]>(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        state: options.state,
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page
      }
    );

    for (const pullRequest of response.data) {
      if (
        updatedSinceTime !== undefined &&
        pullRequest.updated_at &&
        Date.parse(pullRequest.updated_at) < updatedSinceTime
      ) {
        return pullRequests;
      }

      pullRequests.push(pullRequest);
    }

    if (response.data.length < 100) {
      return pullRequests;
    }
  }
}

async function getTokenPullRequest(
  octokit: RequestingOctokit,
  lookup: GitHubPullRequestLookupInput
): Promise<GitHubPullRequestSnapshot | undefined> {
  const [owner, repo] = lookup.repository.split("/");
  if (!owner || !repo) {
    return undefined;
  }

  try {
    const response = await octokit.request<GitHubPullRequestFromApi>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: lookup.number
      }
    );
    const [reviews, changedFiles] = await Promise.all([
      listPullRequestReviews(octokit, owner, repo, response.data.number),
      listPullRequestFiles(octokit, owner, repo, response.data.number)
    ]);

    return {
      repository: {
        full_name: lookup.repository,
        html_url: `https://github.com/${lookup.repository}`,
        owner: { login: owner }
      },
      pull_request: {
        ...response.data,
        merged: response.data.merged ?? Boolean(response.data.merged_at)
      },
      reviews,
      changed_files: changedFiles
    };
  } catch (error) {
    if (isGithubNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isGithubNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

async function listPullRequestReviews(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubReviewFromApi[]> {
  const reviews: GitHubReviewFromApi[] = [];

  for (let page = 1; ; page += 1) {
    const response = await octokit.request<GitHubReviewFromApi[]>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page
      }
    );

    reviews.push(...response.data);

    if (response.data.length < 100) {
      return reviews;
    }
  }
}

async function listPullRequestFiles(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubChangedFileFromApi[]> {
  const files: GitHubChangedFileFromApi[] = [];

  for (let page = 1; ; page += 1) {
    const response = await octokit.request<GitHubChangedFileFromApi[]>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page
      }
    );

    files.push(...response.data);

    if (response.data.length < 100) {
      return files;
    }
  }
}

function createTokenRequest(input: {
  token: string;
  apiBaseUrl?: string;
}): RequestingOctokit["request"] {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";

  return async <T = unknown>(
    route: string,
    parameters: Record<string, unknown> = {}
  ): Promise<{ data: T }> => {
    const [method, routePath] = route.split(" ");
    if (!method || !routePath) {
      throw new Error(`Unsupported GitHub route: ${route}`);
    }

    const usedParameterNames = new Set<string>();
    const pathname = routePath.replace(/\{([^}]+)\}/g, (_match, rawName) => {
      const name = String(rawName);
      usedParameterNames.add(name);
      const value = parameters[name];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Missing GitHub route parameter: ${name}`);
      }

      return encodeURIComponent(String(value));
    });
    const url = new URL(pathname, apiBaseUrl);

    for (const [name, value] of Object.entries(parameters)) {
      if (usedParameterNames.has(name) || value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(name, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28"
      }
    });

    if (!response.ok) {
      const error = new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}`
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return { data: (await response.json()) as T };
  };
}
