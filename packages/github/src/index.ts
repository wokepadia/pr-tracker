import { App } from "@octokit/app";
import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";

export const githubAppAuthEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1)
});

export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1)
});

export type GithubAppAuthEnv = z.infer<typeof githubAppAuthEnvSchema>;
export type GithubAppEnv = z.infer<typeof githubAppEnvSchema>;

export function createGithubApp(env: GithubAppAuthEnv): App {
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY
  });
}

export async function verifyGithubWebhook(input: {
  secret: string;
  payload: string;
  signature: string | null;
}): Promise<boolean> {
  if (!input.signature) {
    return false;
  }

  return verify(input.secret, input.payload, input.signature);
}

export function getGithubAppEnv(
  env: Record<string, string | undefined>
): GithubAppEnv | undefined {
  const result = githubAppEnvSchema.safeParse(env);
  return result.success ? result.data : undefined;
}

export function getGithubAppAuthEnv(
  env: Record<string, string | undefined>
): GithubAppAuthEnv | undefined {
  const result = githubAppAuthEnvSchema.safeParse(env);
  return result.success ? result.data : undefined;
}

export interface NormalizedWebhookEvent {
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: number;
  receivedAt: string;
  rawPayload: unknown;
}

export function normalizeWebhookEvent(input: {
  deliveryId: string;
  eventName: string;
  payload: unknown;
  receivedAt?: string;
}): NormalizedWebhookEvent {
  const payload = input.payload as {
    action?: string;
    installation?: { id?: number };
  };

  return {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    action: payload.action,
    installationId: payload.installation?.id,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    rawPayload: input.payload
  };
}

export interface GitHubPullRequestSnapshot {
  installationId?: number;
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

export interface GitHubPullRequestLookupInput {
  installationId?: number;
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

export function createGithubPullRequestSource(input: {
  app: App;
  installationId?: number;
  closedLookbackDays?: number;
}): GitHubPullRequestSource {
  return {
    async listPullRequests() {
      return listInstallationPullRequests(input, { includeRecentClosed: true });
    },
    async listOpenPullRequests() {
      return listInstallationPullRequests(input, { includeRecentClosed: false });
    },
    async getPullRequest(lookup) {
      const installationId = lookup.installationId ?? input.installationId;
      if (!installationId) {
        return undefined;
      }

      return getInstallationPullRequest(input.app, installationId, lookup);
    }
  };
}

export function getGithubInstallationId(
  env: Record<string, string | undefined>
): number | undefined {
  const raw = env.GITHUB_INSTALLATION_ID;
  if (!raw) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

async function listInstallationPullRequests(
  input: {
    app: App;
    installationId?: number;
    closedLookbackDays?: number;
  },
  options: { includeRecentClosed: boolean }
): Promise<GitHubPullRequestSnapshot[]> {
  const snapshots: GitHubPullRequestSnapshot[] = [];
  const installationIds = await listInstallationIds(
    input.app,
    input.installationId
  );
  const closedUpdatedSince = new Date(
    Date.now() - (input.closedLookbackDays ?? 30) * 24 * 60 * 60 * 1000
  ).toISOString();

  for (const installationId of installationIds) {
    for await (const { octokit, repository } of input.app.eachRepository.iterator({
      installationId
    })) {
      const repo = repository as GitHubRepositoryFromApi;
      const [owner, name] = repo.full_name.split("/");

      if (!owner || !name) {
        continue;
      }

      const openPullRequests = await listRepoPullRequests(
        octokit as RequestingOctokit,
        owner,
        name,
        { state: "open" }
      );
      const recentlyClosedPullRequests = options.includeRecentClosed
        ? await listRepoPullRequests(octokit as RequestingOctokit, owner, name, {
            state: "closed",
            updatedSince: closedUpdatedSince
          })
        : [];

      for (const pullRequest of [
        ...openPullRequests,
        ...recentlyClosedPullRequests
      ]) {
        const reviews = await listPullRequestReviews(
          octokit as RequestingOctokit,
          owner,
          name,
          pullRequest.number
        );

        snapshots.push({
          installationId,
          repository: {
            full_name: repo.full_name,
            html_url: repo.html_url,
            owner: { login: repo.owner?.login ?? owner }
          },
          pull_request: {
            ...pullRequest,
            merged: pullRequest.merged ?? Boolean(pullRequest.merged_at)
          },
          reviews
        });
      }
    }
  }

  return snapshots;
}

async function listInstallationIds(
  app: App,
  configuredInstallationId: number | undefined
): Promise<number[]> {
  if (configuredInstallationId) {
    return [configuredInstallationId];
  }

  const installationIds: number[] = [];
  for await (const { installation } of app.eachInstallation.iterator()) {
    installationIds.push(installation.id);
  }

  return installationIds;
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

async function getInstallationPullRequest(
  app: App,
  installationId: number,
  lookup: GitHubPullRequestLookupInput
): Promise<GitHubPullRequestSnapshot | undefined> {
  const [owner, repo] = lookup.repository.split("/");
  if (!owner || !repo) {
    return undefined;
  }

  const octokit = (await app.getInstallationOctokit(
    installationId
  )) as RequestingOctokit;

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
      installationId,
      repository: {
        full_name: lookup.repository,
        owner: { login: owner }
      },
      pull_request: {
        ...response.data,
        merged: response.data.merged ?? Boolean(response.data.merged_at)
      },
      reviews
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
