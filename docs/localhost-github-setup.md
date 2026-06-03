# Localhost GitHub Setup

## Goal

Run the reviewer inbox locally with real GitHub pull requests and no in-app login.

The app chooses its data source at API startup:

1. GitHub token mode when `GITHUB_TOKEN` and `GITHUB_REPOSITORIES` are set.
2. Database mode when `PR_TRACKER_USE_DATABASE=true`.
3. Sample data when neither is configured.

For the current localhost product, use a read-only personal access token.

## Token Mode

Open `http://127.0.0.1:5176/settings` and enter:

- a read-only GitHub token
- one or more repositories, for example `zulip/zulip`
- your GitHub username

The API stores the token in macOS Keychain and stores the non-secret repository settings in local application config. The token is never returned to the browser after saving.

Equivalent environment variables still work if you prefer starting the API from a configured shell:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

`GITHUB_REPOSITORIES` is required in token mode. It keeps the local app scoped to an explicit allow-list instead of scanning every repository the token can access.

The token only needs read access for the current V1 reviewer inbox. A fine-grained personal access token should be scoped to the selected repositories with repository `Pull requests` read access. GitHub always includes metadata read access for selected repositories.

`PR_TRACKER_VIEWER_LOGIN` is optional in token mode because the API can call GitHub's current-user endpoint. Set it anyway when testing against mocked or enterprise API environments.

## Current Local Behavior

The live GitHub API path reads pull requests, requested reviewers, submitted reviews, and changed files. It derives reviewer workflow states locally from that deterministic data.

The "mark seen" action is stored in memory for the current API process. Restarting the API clears local seen state until database-backed persistence is enabled for this flow.

No GitHub writes are made from the app in this phase. Review submission still happens in GitHub.
