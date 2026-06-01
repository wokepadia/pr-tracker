import { getGithubAppEnv } from "@pr-tracker/github";
import { buildSampleInbox } from "@pr-tracker/reviewer-workflow";

const githubEnv = getGithubAppEnv(process.env);
const inbox = buildSampleInbox(new Date().toISOString());

console.log(
  JSON.stringify(
    {
      worker: "pr-tracker-worker",
      mode: githubEnv ? "github-app-configured" : "sample-data",
      activePullRequests: inbox.items.length,
      sections: Object.fromEntries(
        Object.entries(inbox.sections).map(([section, items]) => [
          section,
          items.length
        ])
      )
    },
    null,
    2
  )
);
