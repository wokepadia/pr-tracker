import { createOrm, syncPullRequestsFromGithub } from "@pr-tracker/db";
import {
  createGithubApp,
  createGithubPullRequestSource,
  getGithubClosedLookbackDays,
  getGithubAppAuthEnv,
  getGithubInstallationId
} from "@pr-tracker/github";

const githubEnv = getGithubAppAuthEnv(process.env);

if (!githubEnv) {
  throw new Error("GitHub App auth is required for worker sync.");
}

if (process.env.PR_TRACKER_USE_DATABASE !== "true") {
  throw new Error("PR_TRACKER_USE_DATABASE=true is required for worker sync.");
}

{
  const orm = await createOrm();

  try {
    const result = await syncPullRequestsFromGithub(
      orm,
      createGithubPullRequestSource({
        app: createGithubApp(githubEnv),
        installationId: getGithubInstallationId(process.env),
        closedLookbackDays: getGithubClosedLookbackDays(process.env)
      })
    );

    console.log(
      JSON.stringify(
        {
          worker: "pr-tracker-worker",
          mode: "github-app-sync",
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
