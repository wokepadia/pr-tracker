import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  getGithubTokenEnv,
  parseGithubRepositories
} from "@pr-tracker/github";
import {
  seedLocalSampleData,
  syncPullRequestsToLocalSqlite
} from "@pr-tracker/db";
import { createDatabaseRepository } from "./database-repository";
import {
  createGithubLiveRepositoryFromCredentials,
  createGithubLiveRepositoryFromEnv
} from "./github-live-repository";
import {
  loadLocalGithubCredentials,
  localGithubSettingsFingerprint,
  type LocalGithubSettingsOptions
} from "./local-github-settings";
import {
  createSampleRepository,
  shouldUseDatabaseRepository,
  type ReviewerInboxRepository
} from "./repository";
import { createLocalSqliteRepository } from "./local-sqlite-repository";
import type { LocalSqliteRepositoryOptions } from "./local-sqlite-repository";

export function createConfiguredRepository(
  env: Record<string, string | undefined> = process.env,
  settingsOptions: LocalGithubSettingsOptions = {}
): ReviewerInboxRepository {
  if (env.PR_TRACKER_USE_LIVE_GITHUB === "true") {
    const githubRepository = createGithubLiveRepositoryFromEnv(env);
    if (githubRepository) {
      return githubRepository;
    }
  }

  if (shouldUseDatabaseRepository(env)) {
    return createDatabaseRepository(env.PR_TRACKER_VIEWER_LOGIN ?? "viewer");
  }

  if (shouldUseLocalSqliteRepository(env)) {
    const viewerLogin = env.PR_TRACKER_VIEWER_LOGIN ?? "viewer";
    return createLocalSqliteRepository({
      path: env.PR_TRACKER_LOCAL_DB_PATH,
      viewerLogin,
      seedSampleData: false,
      beforeRead: createLocalSqliteSyncBeforeRead(env, settingsOptions, viewerLogin)
    });
  }

  return createLocalSettingsRepository(env, settingsOptions);
}

function shouldUseLocalSqliteRepository(
  env: Record<string, string | undefined>
): boolean {
  return env.PR_TRACKER_USE_LIVE_GITHUB !== "true";
}

function createLocalSettingsRepository(
  env: Record<string, string | undefined>,
  settingsOptions: LocalGithubSettingsOptions
): ReviewerInboxRepository {
  const sampleRepository = createSampleRepository();
  let cachedGithubRepository:
    | {
        fingerprint: string;
        repository: ReviewerInboxRepository;
      }
    | undefined;

  async function getRepository(): Promise<ReviewerInboxRepository> {
    const credentials =
      (await loadLocalGithubCredentials(settingsOptions)) ??
      loadEnvGithubCredentials(env);

    if (!credentials) {
      return sampleRepository;
    }

    const fingerprint = localGithubSettingsFingerprint(credentials);
    if (cachedGithubRepository?.fingerprint !== fingerprint) {
      cachedGithubRepository = {
        fingerprint,
        repository: createGithubLiveRepositoryFromCredentials({
          token: credentials.token,
          repositories: credentials.repositories,
          viewerLogin: credentials.viewerLogin,
          apiBaseUrl: credentials.apiBaseUrl,
          closedLookbackDays: parsePositiveInteger(
            env.GITHUB_CLOSED_LOOKBACK_DAYS
          ),
          maxPullRequests: parsePositiveInteger(env.GITHUB_MAX_PULL_REQUESTS)
        })
      };
    }

    return cachedGithubRepository.repository;
  }

  return {
    async getReviewerInbox(now, options) {
      return (await getRepository()).getReviewerInbox(now, options);
    },

    async getPullRequest(id) {
      return (await getRepository()).getPullRequest(id);
    },

    async markSeen(input) {
      return (await getRepository()).markSeen(input);
    }
  };
}

function loadEnvGithubCredentials(
  env: Record<string, string | undefined>
): {
  token: string;
  repositories: string[];
  viewerLogin?: string;
  apiBaseUrl?: string;
} | undefined {
  const tokenEnv = getGithubTokenEnv(env);
  if (!tokenEnv) {
    return undefined;
  }

  return {
    token: tokenEnv.GITHUB_TOKEN,
    repositories: parseGithubRepositories(tokenEnv.GITHUB_REPOSITORIES),
    viewerLogin: env.PR_TRACKER_VIEWER_LOGIN,
    apiBaseUrl: tokenEnv.GITHUB_API_BASE_URL
  };
}

function createLocalSqliteSyncBeforeRead(
  env: Record<string, string | undefined>,
  settingsOptions: LocalGithubSettingsOptions,
  defaultViewerLogin: string
): LocalSqliteRepositoryOptions["beforeRead"] {
  let lastSuccessfulFingerprint: string | undefined;
  let lastSuccessfulScope: { pullRequestIds?: string[] } | undefined;

  return async ({ local, githubSearchQuery }) => {
    const credentials =
      (await loadLocalGithubCredentials(settingsOptions)) ??
      loadEnvGithubCredentials(env);

    if (!credentials) {
      if (isLocalSqliteDatabaseEmpty(local.db)) {
        seedLocalSampleData(local.db, { viewerLogin: defaultViewerLogin });
      }
      return;
    }

    const fingerprint = JSON.stringify({
      credentials: localGithubSettingsFingerprint(credentials),
      githubSearchQuery: githubSearchQuery ?? ""
    });
    if (lastSuccessfulFingerprint === fingerprint) {
      return lastSuccessfulScope;
    }

    const source = createGithubTokenPullRequestSource({
      token: credentials.token,
      repositories: credentials.repositories,
      apiBaseUrl: credentials.apiBaseUrl,
      closedLookbackDays: getGithubClosedLookbackDays(env),
      maxPullRequests: parsePositiveInteger(env.GITHUB_MAX_PULL_REQUESTS)
    });
    const viewerLogin =
      credentials.viewerLogin ??
      env.PR_TRACKER_VIEWER_LOGIN ??
      (await source.getViewerLogin());

    try {
      const result = await syncPullRequestsToLocalSqlite(local.db, source, {
        sourceName: "local-settings",
        viewerLogin,
        searchQuery: githubSearchQuery
      });
      lastSuccessfulScope = githubSearchQuery
        ? { pullRequestIds: result.pullRequestIds }
        : undefined;
      lastSuccessfulFingerprint = fingerprint;
    } catch (error) {
      console.error("Failed to sync GitHub data into local SQLite.", error);
      throw new Error(
        error instanceof Error
          ? `Failed to sync GitHub data: ${error.message}`
          : "Failed to sync GitHub data."
      );
    }

    return lastSuccessfulScope;
  };
}

function isLocalSqliteDatabaseEmpty(db: {
  prepare(sql: string): { get(): unknown };
}): boolean {
  const row = db.prepare(`select count(*) as count from pull_requests`).get() as {
    count: number;
  };
  return row.count === 0;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
