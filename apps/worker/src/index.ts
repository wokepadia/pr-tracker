import {
  openLocalDatabase,
  syncPullRequestsToLocalSqlite
} from "@pr-tracker/db";
import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  getGithubTokenEnv,
  parseGithubRepositories
} from "@pr-tracker/github";

const githubEnv = getGithubTokenEnv(process.env);

if (!githubEnv) {
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORIES are required for worker sync.");
}

{
  const local = openLocalDatabase({ path: process.env.PR_TRACKER_LOCAL_DB_PATH });
  const source = createGithubTokenPullRequestSource({
    token: githubEnv.GITHUB_TOKEN,
    repositories: parseGithubRepositories(githubEnv.GITHUB_REPOSITORIES),
    apiBaseUrl: githubEnv.GITHUB_API_BASE_URL,
    closedLookbackDays: getGithubClosedLookbackDays(process.env)
  });

  try {
    const viewerLogin =
      process.env.PR_TRACKER_VIEWER_LOGIN ?? (await source.getViewerLogin());
    const result = await syncPullRequestsToLocalSqlite(local.db, source, {
      sourceName: "worker",
      viewerLogin
    });

    console.log(
      JSON.stringify(
        {
          worker: "pr-tracker-worker",
          mode: "github-token-sync",
          ...result
        },
        null,
        2
      )
    );
  } finally {
    local.close();
  }
}
