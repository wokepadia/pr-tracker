import { createDatabaseRepository } from "./database-repository";
import { createGithubLiveRepositoryFromEnv } from "./github-live-repository";
import {
  createSampleRepository,
  shouldUseDatabaseRepository,
  type ReviewerInboxRepository
} from "./repository";

export function createConfiguredRepository(
  env: Record<string, string | undefined> = process.env
): ReviewerInboxRepository {
  const githubRepository = createGithubLiveRepositoryFromEnv(env);
  if (githubRepository) {
    return githubRepository;
  }

  if (shouldUseDatabaseRepository(env)) {
    return createDatabaseRepository(env.PR_TRACKER_VIEWER_LOGIN ?? "viewer");
  }

  return createSampleRepository();
}
