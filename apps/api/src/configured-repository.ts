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

export function createConfiguredRepository(
  env: Record<string, string | undefined> = process.env,
  settingsOptions: LocalGithubSettingsOptions = {}
): ReviewerInboxRepository {
  const githubRepository = createGithubLiveRepositoryFromEnv(env);
  if (githubRepository) {
    return githubRepository;
  }

  if (shouldUseDatabaseRepository(env)) {
    return createDatabaseRepository(env.PR_TRACKER_VIEWER_LOGIN ?? "viewer");
  }

  return createLocalSettingsRepository(env, settingsOptions);
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
    const credentials = await loadLocalGithubCredentials(settingsOptions).catch(
      (error: unknown) => {
        console.error("Failed to load local GitHub settings.", error);
        return undefined;
      }
    );

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
          )
        })
      };
    }

    return cachedGithubRepository.repository;
  }

  return {
    async getReviewerInbox(now) {
      return (await getRepository()).getReviewerInbox(now);
    },

    async getPullRequest(id) {
      return (await getRepository()).getPullRequest(id);
    },

    async markSeen(input) {
      return (await getRepository()).markSeen(input);
    }
  };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
