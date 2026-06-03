import { createOrm, syncPullRequestsFromGithub } from "@pr-tracker/db";
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

if (process.env.PR_TRACKER_USE_DATABASE !== "true") {
  throw new Error("PR_TRACKER_USE_DATABASE=true is required for worker sync.");
}

{
  const orm = await createOrm();

  try {
    const result = await syncPullRequestsFromGithub(
      orm,
      createGithubTokenPullRequestSource({
        token: githubEnv.GITHUB_TOKEN,
        repositories: parseGithubRepositories(githubEnv.GITHUB_REPOSITORIES),
        closedLookbackDays: getGithubClosedLookbackDays(process.env)
      })
    );

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
    await orm.close(true);
  }
}
