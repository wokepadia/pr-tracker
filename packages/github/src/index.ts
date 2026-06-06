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
    body?: string | null;
    html_url?: string;
    state?: string;
    draft?: boolean;
    created_at?: string;
    updated_at?: string;
    user?: { login?: string; avatar_url?: string };
    head?: { sha?: string };
    merged?: boolean;
    requested_reviewers?: Array<{ login?: string; avatar_url?: string }>;
  };
  reviews?: GitHubReviewSnapshot[];
}

export interface GitHubReviewSnapshot {
  id: number;
  node_id?: string;
  state?: string;
  body?: string | null;
  submitted_at?: string;
  commit_id?: string;
  user?: { login?: string; avatar_url?: string };
}

export interface GitHubPullRequestLookupInput {
  repository: string;
  number: number;
}

export interface GitHubPullRequestListOptions {
  searchQuery?: string;
}

interface GitHubPullRequestLookupSource {
  getPullRequest?(
    input: GitHubPullRequestLookupInput
  ): Promise<GitHubPullRequestSnapshot | undefined>;
}

export type GitHubPullRequestSource =
  | (GitHubPullRequestLookupSource & {
      listPullRequests(
        options?: GitHubPullRequestListOptions
      ): Promise<GitHubPullRequestSnapshot[]>;
      listOpenPullRequests?: (
        options?: GitHubPullRequestListOptions
      ) => Promise<GitHubPullRequestSnapshot[]>;
    })
  | (GitHubPullRequestLookupSource & {
      listPullRequests?: (
        options?: GitHubPullRequestListOptions
      ) => Promise<GitHubPullRequestSnapshot[]>;
      listOpenPullRequests(
        options?: GitHubPullRequestListOptions
      ): Promise<GitHubPullRequestSnapshot[]>;
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
  body?: string | null;
  html_url?: string;
  state?: string;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; avatar_url?: string };
  head?: { sha?: string };
  merged?: boolean;
  merged_at?: string | null;
  requested_reviewers?: Array<{ login?: string; avatar_url?: string }>;
}

interface GitHubReviewFromApi {
  id: number;
  node_id?: string;
  state?: string;
  body?: string | null;
  submitted_at?: string;
  commit_id?: string;
  user?: { login?: string; avatar_url?: string };
}

interface GitHubIssueSearchResultFromApi {
  number: number;
  repository_url?: string;
  pull_request?: {
    url?: string;
    html_url?: string;
  };
}

interface GitHubUserFromApi {
  login: string;
}

export function createGithubTokenPullRequestSource(input: {
  token: string;
  repositories: string[];
  apiBaseUrl?: string;
  closedLookbackDays?: number;
  maxPullRequests?: number;
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
    async listPullRequests(options) {
      const searchQuery = cleanGithubSearchQuery(options?.searchQuery);
      if (searchQuery) {
        return listSearchedPullRequests(octokit, input.repositories, searchQuery, {
          maxPullRequests: input.maxPullRequests
        });
      }

      return listConfiguredRepositoryPullRequests(octokit, input.repositories, {
        includeRecentClosed: true,
        closedLookbackDays: input.closedLookbackDays,
        maxPullRequests: input.maxPullRequests
      });
    },
    async listOpenPullRequests(options) {
      const searchQuery = cleanGithubSearchQuery(options?.searchQuery);
      if (searchQuery) {
        return listSearchedPullRequests(octokit, input.repositories, searchQuery, {
          maxPullRequests: input.maxPullRequests
        });
      }

      return listConfiguredRepositoryPullRequests(octokit, input.repositories, {
        includeRecentClosed: false,
        closedLookbackDays: input.closedLookbackDays,
        maxPullRequests: input.maxPullRequests
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
    maxPullRequests?: number;
  }
): Promise<GitHubPullRequestSnapshot[]> {
  const snapshots: GitHubPullRequestSnapshot[] = [];
  const maxPullRequests = options.maxPullRequests ?? 20;
  const closedUpdatedSince = new Date(
    Date.now() - (options.closedLookbackDays ?? 30) * 24 * 60 * 60 * 1000
  ).toISOString();

  for (const repository of repositories) {
    const [owner, name] = repository.split("/");
    if (!owner || !name) {
      continue;
    }

    const openPullRequests = await listRepoPullRequests(octokit, owner, name, {
      state: "open",
      maxCount: maxPullRequests
    });
    const remainingPullRequestCapacity = Math.max(
      maxPullRequests - openPullRequests.length,
      0
    );
    const recentlyClosedPullRequests = options.includeRecentClosed
      && remainingPullRequestCapacity > 0
      ? await listRepoPullRequests(octokit, owner, name, {
          state: "closed",
          updatedSince: closedUpdatedSince,
          maxCount: remainingPullRequestCapacity
        })
      : [];
    const pullRequests = [...openPullRequests, ...recentlyClosedPullRequests]
      .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))
      .slice(0, maxPullRequests);

    const hydratedPullRequests = await mapConcurrent(
      pullRequests,
      8,
      async (pullRequest) => {
        const reviews = await listPullRequestReviews(
          octokit,
          owner,
          name,
          pullRequest.number
        );

        return {
          repository: {
            full_name: repository,
            html_url: `https://github.com/${repository}`,
            owner: { login: owner }
          },
          pull_request: {
            ...pullRequest,
            merged: pullRequest.merged ?? Boolean(pullRequest.merged_at)
          },
          reviews: stripReviewBodies(reviews)
        };
      }
    );

    snapshots.push(...hydratedPullRequests);
  }

  return snapshots;
}

async function listSearchedPullRequests(
  octokit: RequestingOctokit,
  repositories: string[],
  searchQuery: string,
  options: {
    maxPullRequests?: number;
  }
): Promise<GitHubPullRequestSnapshot[]> {
  const maxPullRequests = options.maxPullRequests ?? 20;
  const query = normalizePullRequestSearchQuery(searchQuery, repositories);
  const searchResults = await listIssueSearchResults(octokit, query, maxPullRequests);
  const lookups = searchResults.flatMap(searchResultToPullRequestLookup);
  const snapshots = await mapConcurrent(lookups, 8, (lookup) =>
    getTokenPullRequest(octokit, lookup, { stripReviewBodies: true })
  );

  return snapshots.filter(
    (snapshot): snapshot is GitHubPullRequestSnapshot => Boolean(snapshot)
  );
}

async function listIssueSearchResults(
  octokit: RequestingOctokit,
  query: string,
  maxCount: number
): Promise<GitHubIssueSearchResultFromApi[]> {
  const items: GitHubIssueSearchResultFromApi[] = [];

  for (let page = 1; ; page += 1) {
    const response = await octokit.request<{
      items: GitHubIssueSearchResultFromApi[];
    }>("GET /search/issues", {
      q: query,
      sort: "updated",
      order: "desc",
      per_page: Math.min(maxCount, 100),
      page
    });

    for (const item of response.data.items) {
      items.push(item);
      if (items.length >= maxCount) {
        return items;
      }
    }

    if (response.data.items.length < Math.min(maxCount, 100)) {
      return items;
    }
  }
}

function searchResultToPullRequestLookup(
  item: GitHubIssueSearchResultFromApi
): GitHubPullRequestLookupInput[] {
  if (!item.pull_request) {
    return [];
  }

  const repository = repositoryFromSearchResult(item);
  if (!repository) {
    return [];
  }

  return [{ repository, number: item.number }];
}

function repositoryFromSearchResult(
  item: GitHubIssueSearchResultFromApi
): string | undefined {
  const repositoryUrl = item.repository_url;
  if (!repositoryUrl) {
    return undefined;
  }

  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function normalizePullRequestSearchQuery(
  searchQuery: string,
  repositories: string[]
): string {
  const query = searchQuery.trim();
  if (/\b(?:is|type):issue\b/i.test(query)) {
    throw new Error(
      "Reviewer inbox search currently supports pull request queries only. Use is:pr or type:pr."
    );
  }

  const parts = [query];
  if (!/\b(?:is|type):(?:pr|pull-request)\b/i.test(query)) {
    parts.push("is:pr");
  }

  if (!/\b(?:repo|org|user):/i.test(query)) {
    const repositoryQualifiers = repositories.map((repository) => `repo:${repository}`);
    if (repositoryQualifiers.length === 1) {
      parts.push(repositoryQualifiers[0] ?? "");
    } else if (repositoryQualifiers.length > 1) {
      parts.push(`(${repositoryQualifiers.join(" OR ")})`);
    }
  }

  return parts.join(" ");
}

function cleanGithubSearchQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function listRepoPullRequests(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  options: {
    state: "open" | "closed";
    updatedSince?: string;
    maxCount?: number;
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
      if (options.maxCount && pullRequests.length >= options.maxCount) {
        return pullRequests;
      }
    }

    if (response.data.length < 100) {
      return pullRequests;
    }
  }
}

async function mapConcurrent<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = [];

  for (let index = 0; index < items.length; index += concurrency) {
    results.push(
      ...(await Promise.all(items.slice(index, index + concurrency).map(mapper)))
    );
  }

  return results;
}

function stripReviewBodies(
  reviews: GitHubReviewFromApi[]
): GitHubReviewFromApi[] {
  return reviews.map((review) => ({ ...review, body: undefined }));
}

async function getTokenPullRequest(
  octokit: RequestingOctokit,
  lookup: GitHubPullRequestLookupInput,
  options: { stripReviewBodies?: boolean } = {}
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
    const reviews = await listPullRequestReviews(
      octokit,
      owner,
      repo,
      response.data.number
    );

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
      reviews: options.stripReviewBodies ? stripReviewBodies(reviews) : reviews
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

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        signal: abortController.signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2022-11-28"
        }
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`GitHub API request timed out for ${route}`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }

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
