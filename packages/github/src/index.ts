import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
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
    additions?: number;
    deletions?: number;
    changed_files?: number;
    labels?: Array<{
      name?: string;
      color?: string | null;
      description?: string | null;
    }>;
    assignees?: Array<{ login?: string; avatar_url?: string }>;
    requested_reviewers?: Array<{ login?: string; avatar_url?: string }>;
  };
  reviews?: GitHubReviewSnapshot[];
  /**
   * Review threads fetched via GraphQL. Undefined means the thread fetch
   * was unavailable (not an empty thread list), so consumers must not
   * treat it as "no threads".
   */
  review_threads?: GitHubReviewThreadSnapshot[];
  /**
   * Top-level pull request conversation comments, fetched from the issue
   * comments endpoint. Undefined means the fetch was unavailable.
   */
  issue_comments?: GitHubIssueCommentSnapshot[];
  /**
   * Combined check/status rollup for the head commit, fetched via GraphQL.
   * Undefined means the rollup was unavailable or the commit has no checks.
   */
  status_check_rollup?: GitHubStatusCheckRollupSnapshot;
}

export interface GitHubStatusCheckRollupSnapshot {
  state: "success" | "failure" | "pending";
  total_count?: number;
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

export interface GitHubReviewThreadSnapshot {
  id: string;
  is_resolved?: boolean;
  is_outdated?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: Array<{
    id?: string;
    author?: { login?: string };
    body?: string;
    path?: string | null;
    line?: number | null;
    created_at?: string;
    updated_at?: string | null;
    url?: string | null;
  }>;
}

export interface GitHubIssueCommentSnapshot {
  id: string;
  author?: { login?: string };
  body: string;
  created_at: string;
  updated_at?: string | null;
  url?: string | null;
}

export interface GitHubPullRequestLookupInput {
  repository: string;
  number: number;
}

export interface GitHubPullRequestFileSnapshot {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunk; absent for binary or very large files. */
  patch?: string;
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
  // Only present on the single-PR detail endpoint, not the list endpoint.
  additions?: number;
  deletions?: number;
  changed_files?: number;
  labels?: Array<{
    name?: string;
    color?: string | null;
    description?: string | null;
  }>;
  assignees?: Array<{ login?: string; avatar_url?: string }>;
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

interface GitHubIssueCommentFromApi {
  id: number;
  node_id?: string;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string | null;
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

interface GitHubPullRequestFileFromApi {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export function createGithubTokenPullRequestSource(input: {
  token: string;
  repositories: string[];
  apiBaseUrl?: string;
  closedLookbackDays?: number;
  maxPullRequests?: number;
  request?: RequestingOctokit["request"];
}): GitHubPullRequestSource & {
  getViewerLogin(): Promise<string>;
  listPullRequestChangedFiles(
    lookup: GitHubPullRequestLookupInput
  ): Promise<GitHubPullRequestFileSnapshot[] | undefined>;
} {
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
    },
    async listPullRequestChangedFiles(lookup) {
      if (!input.repositories.includes(lookup.repository)) {
        return undefined;
      }

      return listTokenPullRequestChangedFiles(octokit, lookup);
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

// Runaway guard for repositories with an unexpectedly large open queue;
// the reviewer inbox must see every open pull request, so this is far
// above any realistic single-user review responsibility.
const defaultMaxOpenPullRequests = 200;
const defaultMaxClosedPullRequests = 20;

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
  const maxOpenPullRequests =
    options.maxPullRequests ?? defaultMaxOpenPullRequests;
  const maxClosedPullRequests =
    options.maxPullRequests ?? defaultMaxClosedPullRequests;
  const closedUpdatedSince = new Date(
    Date.now() - (options.closedLookbackDays ?? 30) * 24 * 60 * 60 * 1000
  ).toISOString();

  for (const repository of repositories) {
    const [owner, name] = repository.split("/");
    if (!owner || !name) {
      continue;
    }

    // created/asc is an immutable sort key, so rows cannot shift across
    // page boundaries mid-pagination the way updated/desc rows do when a
    // pull request is updated between page fetches.
    const openPullRequests = await listRepoPullRequests(octokit, owner, name, {
      state: "open",
      sort: "created",
      direction: "asc",
      maxCount: maxOpenPullRequests
    });
    const recentlyClosedPullRequests = options.includeRecentClosed
      ? await listRepoPullRequests(octokit, owner, name, {
          state: "closed",
          updatedSince: closedUpdatedSince,
          maxCount: maxClosedPullRequests
        })
      : [];
    // A pull request that closes between the two list calls shows up in
    // both; keep the snapshot with the newest update.
    const pullRequests = dedupePullRequestsByNumber([
      ...openPullRequests,
      ...recentlyClosedPullRequests
    ]);

    const hydratedPullRequests = await mapConcurrent(
      pullRequests,
      8,
      async (pullRequest) => {
        const [reviews, graphqlFacts, issueComments] = await Promise.all([
          listPullRequestReviews(octokit, owner, name, pullRequest.number),
          fetchPullRequestGraphqlFacts(octokit, owner, name, pullRequest.number),
          listIssueComments(octokit, owner, name, pullRequest.number)
        ]);

        return {
          repository: {
            full_name: repository,
            html_url: `https://github.com/${repository}`,
            owner: { login: owner }
          },
          pull_request: {
            ...withGraphqlSizeFallback(pullRequest, graphqlFacts.size),
            merged: pullRequest.merged ?? Boolean(pullRequest.merged_at)
          },
          reviews: stripReviewBodies(reviews),
          review_threads: graphqlFacts.reviewThreads,
          issue_comments: issueComments,
          status_check_rollup: graphqlFacts.statusCheckRollup
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
  const lookups = dedupePullRequestLookups(
    searchResults.flatMap(searchResultToPullRequestLookup)
  );
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
      // The generated query uses advanced syntax such as parenthesized
      // repo OR groups, which the legacy issue search does not parse.
      advanced_search: "true",
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

function dedupePullRequestLookups(
  lookups: GitHubPullRequestLookupInput[]
): GitHubPullRequestLookupInput[] {
  const byKey = new Map<string, GitHubPullRequestLookupInput>();
  for (const lookup of lookups) {
    byKey.set(`${lookup.repository}#${lookup.number}`, lookup);
  }
  return [...byKey.values()];
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

function dedupePullRequestsByNumber(
  pullRequests: GitHubPullRequestFromApi[]
): GitHubPullRequestFromApi[] {
  const byNumber = new Map<number, GitHubPullRequestFromApi>();

  for (const pullRequest of pullRequests) {
    const existing = byNumber.get(pullRequest.number);
    if (
      !existing ||
      Date.parse(pullRequest.updated_at ?? "") >
        Date.parse(existing.updated_at ?? "")
    ) {
      byNumber.set(pullRequest.number, pullRequest);
    }
  }

  return [...byNumber.values()];
}

async function listRepoPullRequests(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  options: {
    state: "open" | "closed";
    sort?: "created" | "updated";
    direction?: "asc" | "desc";
    updatedSince?: string;
    maxCount?: number;
  }
): Promise<GitHubPullRequestFromApi[]> {
  const pullRequests: GitHubPullRequestFromApi[] = [];
  const seenNumbers = new Set<number>();
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
        sort: options.sort ?? "updated",
        direction: options.direction ?? "desc",
        per_page: 100,
        page
      }
    );

    for (const pullRequest of response.data) {
      // Rows that shift across page boundaries between fetches would
      // otherwise be ingested twice.
      if (seenNumbers.has(pullRequest.number)) {
        continue;
      }
      seenNumbers.add(pullRequest.number);
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

const maxIssueCommentPages = 10;

async function listIssueComments(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssueCommentSnapshot[] | undefined> {
  try {
    const comments: GitHubIssueCommentSnapshot[] = [];

    for (let page = 1; page <= maxIssueCommentPages; page += 1) {
      const response = await octokit.request<GitHubIssueCommentFromApi[]>(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
          page
        }
      );

      comments.push(
        ...response.data.flatMap((comment) => {
          const id = comment.node_id ?? String(comment.id);
          const body = comment.body?.trim();
          const createdAt = comment.created_at;
          if (!id || !body || !createdAt) {
            return [];
          }

          return [
            {
              id,
              author: comment.user?.login
                ? { login: comment.user.login }
                : undefined,
              body,
              created_at: createdAt,
              updated_at: comment.updated_at,
              url: comment.html_url
            }
          ];
        })
      );

      if (response.data.length < 100) {
        break;
      }
    }

    return comments;
  } catch {
    return undefined;
  }
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
    const [reviews, graphqlFacts, issueComments] = await Promise.all([
      listPullRequestReviews(octokit, owner, repo, response.data.number),
      fetchPullRequestGraphqlFacts(octokit, owner, repo, response.data.number),
      listIssueComments(octokit, owner, repo, response.data.number)
    ]);

    return {
      repository: {
        full_name: lookup.repository,
        html_url: `https://github.com/${lookup.repository}`,
        owner: { login: owner }
      },
      pull_request: {
        ...withGraphqlSizeFallback(response.data, graphqlFacts.size),
        merged: response.data.merged ?? Boolean(response.data.merged_at)
      },
      reviews: options.stripReviewBodies ? stripReviewBodies(reviews) : reviews,
      review_threads: graphqlFacts.reviewThreads,
      issue_comments: issueComments,
      status_check_rollup: graphqlFacts.statusCheckRollup
    };
  } catch (error) {
    if (isGithubNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Lists the changed files of a pull request with their unified-diff patches,
 * for on-demand AI change summaries. Capped at three pages (300 files);
 * beyond that the listing is representative enough for a summary and the
 * prompt builder truncates further anyway.
 */
async function listTokenPullRequestChangedFiles(
  octokit: RequestingOctokit,
  lookup: GitHubPullRequestLookupInput
): Promise<GitHubPullRequestFileSnapshot[] | undefined> {
  const [owner, repo] = lookup.repository.split("/");
  if (!owner || !repo) {
    return undefined;
  }

  const files: GitHubPullRequestFileSnapshot[] = [];
  const perPage = 100;
  const maxPages = 3;

  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await octokit.request<GitHubPullRequestFileFromApi[]>(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner,
          repo,
          pull_number: lookup.number,
          per_page: perPage,
          page
        }
      );

      for (const file of response.data) {
        if (!file.filename) {
          continue;
        }

        files.push({
          path: file.filename,
          status: file.status ?? "modified",
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          patch: file.patch
        });
      }

      if (response.data.length < perPage) {
        break;
      }
    }

    return files;
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

const reviewThreadsGraphqlQuery = `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        additions
        deletions
        changedFiles
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 0) {
                  totalCount
                }
              }
            }
          }
        }
        reviewThreads(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(last: 50) {
              nodes {
                id
                author { login }
                body
                path
                line
                createdAt
                updatedAt
                url
              }
            }
          }
        }
      }
    }
  }
`;

interface GitHubReviewThreadsGraphqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        additions?: number;
        deletions?: number;
        changedFiles?: number;
        commits?: {
          nodes?: Array<{
            commit?: {
              statusCheckRollup?: {
                state?: string;
                contexts?: { totalCount?: number };
              } | null;
            };
          } | null>;
        };
        reviewThreads?: {
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
          nodes?: Array<{
            id?: string;
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string | null;
            line?: number | null;
            comments?: {
              nodes?: Array<{
                id?: string;
                author?: { login?: string } | null;
                body?: string;
                path?: string | null;
                line?: number | null;
                createdAt?: string;
                updatedAt?: string | null;
                url?: string | null;
              } | null>;
            };
          } | null>;
        };
      };
    };
  };
  errors?: unknown[];
}

interface PullRequestGraphqlFacts {
  reviewThreads?: GitHubReviewThreadSnapshot[];
  size?: {
    additions?: number;
    deletions?: number;
    changed_files?: number;
  };
  statusCheckRollup?: GitHubStatusCheckRollupSnapshot;
}

function toStatusCheckRollupSnapshot(
  rollup:
    | { state?: string; contexts?: { totalCount?: number } }
    | null
    | undefined
): GitHubStatusCheckRollupSnapshot | undefined {
  if (!rollup?.state) {
    return undefined;
  }

  const state =
    rollup.state === "SUCCESS"
      ? "success"
      : rollup.state === "FAILURE" || rollup.state === "ERROR"
        ? "failure"
        : "pending";

  return { state, total_count: rollup.contexts?.totalCount };
}

// Runaway guard: 40 pages of 50 covers 2000 threads, far beyond any
// reviewable pull request.
const maxReviewThreadPages = 40;

async function fetchPullRequestGraphqlFacts(
  octokit: RequestingOctokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestGraphqlFacts> {
  try {
    const reviewThreads: GitHubReviewThreadSnapshot[] = [];
    let size: PullRequestGraphqlFacts["size"];
    let statusCheckRollup: GitHubStatusCheckRollupSnapshot | undefined;
    let cursor: string | null = null;

    for (let page = 0; page < maxReviewThreadPages; page += 1) {
      const response: { data: GitHubReviewThreadsGraphqlResponse } =
        await octokit.request<GitHubReviewThreadsGraphqlResponse>(
          "POST /graphql",
          {
            query: reviewThreadsGraphqlQuery,
            variables: { owner, name: repo, number: pullNumber, cursor }
          }
        );
      const pullRequest = response.data.data?.repository?.pullRequest;
      if (!pullRequest) {
        return {};
      }

      size ??= {
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changed_files: pullRequest.changedFiles
      };
      statusCheckRollup ??= toStatusCheckRollupSnapshot(
        pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup
      );

      const nodes = pullRequest.reviewThreads?.nodes ?? [];
      reviewThreads.push(
        ...nodes
          .filter((node): node is NonNullable<typeof node> => Boolean(node?.id))
          .map((node) => ({
            id: node.id as string,
            is_resolved: node.isResolved ?? false,
            is_outdated: node.isOutdated ?? false,
            path: node.path,
            line: node.line,
            comments: (node.comments?.nodes ?? [])
              .filter((comment): comment is NonNullable<typeof comment> =>
                Boolean(comment)
              )
              .map((comment) => ({
                id: comment.id,
                author: comment.author?.login
                  ? { login: comment.author.login }
                  : undefined,
                body: comment.body,
                path: comment.path,
                line: comment.line,
                created_at: comment.createdAt,
                updated_at: comment.updatedAt,
                url: comment.url
              }))
          }))
      );

      const pageInfo = pullRequest.reviewThreads?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        break;
      }
      cursor = pageInfo.endCursor;
    }

    return { size, reviewThreads, statusCheckRollup };
  } catch {
    // GraphQL facts are an enrichment; a failed call (older GHES, token
    // without GraphQL access) must not fail the whole sync. A failure on
    // any page discards the partial thread list so ingestion never
    // mistakes a truncated ledger for the full one.
    return {};
  }
}

function withGraphqlSizeFallback(
  pullRequest: GitHubPullRequestFromApi,
  size: PullRequestGraphqlFacts["size"]
): GitHubPullRequestFromApi {
  if (!size) {
    return pullRequest;
  }

  return {
    ...pullRequest,
    additions: pullRequest.additions ?? size.additions,
    deletions: pullRequest.deletions ?? size.deletions,
    changed_files: pullRequest.changed_files ?? size.changed_files
  };
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

const requestTimeoutMs = 15_000;
const maxRateLimitRetries = 2;

const ThrottledOctokit = Octokit.plugin(retry, throttling);

function createTokenRequest(input: {
  token: string;
  apiBaseUrl?: string;
}): RequestingOctokit["request"] {
  const octokit = new ThrottledOctokit({
    auth: input.token,
    baseUrl: (input.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, ""),
    request: {
      // Octokit has no built-in timeout; without one a stalled connection
      // hangs the whole sync.
      fetch: (url: RequestInfo | URL, options?: RequestInit) =>
        fetch(url, {
          ...options,
          signal: options?.signal ?? AbortSignal.timeout(requestTimeoutMs)
        })
    },
    throttle: {
      onRateLimit: (_retryAfter, _options, _client, retryCount) =>
        retryCount < maxRateLimitRetries,
      onSecondaryRateLimit: (_retryAfter, _options, _client, retryCount) =>
        retryCount < maxRateLimitRetries
    }
  });

  return async <T = unknown>(
    route: string,
    parameters?: Record<string, unknown>
  ): Promise<{ data: T }> => {
    const response = await octokit.request(route, parameters);
    return { data: response.data as T };
  };
}
