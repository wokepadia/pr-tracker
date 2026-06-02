# Localhost GitHub Setup

## Goal

Run the reviewer inbox locally with real GitHub pull requests and no in-app login.

The app chooses its data source at API startup:

1. GitHub token mode when `GITHUB_TOKEN` and `GITHUB_REPOSITORIES` are set.
2. GitHub App mode when `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` are set.
3. Database mode when `PR_TRACKER_USE_DATABASE=true`.
4. Sample data when none of the above are configured.

For the current localhost product, token mode is the fastest path. GitHub App mode is supported for long-term integration work.

## Token Mode

Set:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

`GITHUB_REPOSITORIES` is required in token mode. It keeps the local app scoped to an explicit allow-list instead of scanning every repository the token can access.

The token needs read access to pull requests in the configured repositories. Fine-grained tokens should be scoped to the specific repositories the user wants to review.

`PR_TRACKER_VIEWER_LOGIN` is optional in token mode because the API can call GitHub's current-user endpoint. Set it anyway when testing against mocked or enterprise API environments.

## GitHub App Mode

Set:

```sh
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_INSTALLATION_ID=12345678
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

`GITHUB_PRIVATE_KEY` may be stored with escaped newlines. The GitHub adapter normalizes `\n` before creating the App client.

`GITHUB_INSTALLATION_ID` is optional. When omitted, the adapter scans all installations the app credentials can access.

`PR_TRACKER_VIEWER_LOGIN` is required in GitHub App mode because installation tokens do not identify the local reviewer user.

## Current Local Behavior

The live GitHub API path reads pull requests, requested reviewers, submitted reviews, and changed files. It derives reviewer workflow states locally from that deterministic data.

The "mark seen" action is stored in memory for the current API process. Restarting the API clears local seen state until database-backed persistence is enabled for this flow.

No GitHub writes are made from the app in this phase. Review submission still happens in GitHub.
