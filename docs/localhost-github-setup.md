# Localhost GitHub Setup

## Goal

Run the reviewer inbox locally with real GitHub pull requests and no in-app login.

The app chooses its data source at API startup:

1. Local SQLite mode by default.
2. Real GitHub data is synced into SQLite when local GitHub settings or
   `GITHUB_TOKEN`/`GITHUB_REPOSITORIES` are configured.
3. Sample data is seeded into SQLite when no GitHub credentials are configured.
4. Legacy live GitHub mode is available only with `PR_TRACKER_USE_LIVE_GITHUB=true`.

For the current localhost product, use a read-only personal access token.

## Local SQLite Token Setup

Open `http://127.0.0.1:5176/settings` and enter:

- a read-only GitHub token
- one or more repositories, for example `zulip/zulip`
- your GitHub username

The API stores the token in macOS Keychain and stores the non-secret repository settings in local application config. The token is never returned to the browser after saving.

After settings are saved, API reads sync selected GitHub pull requests into the
local SQLite database and serve the reviewer inbox from that local cache. Board
labels, card placement, pin/mute/snooze state, last-seen state, and column widths
also persist in SQLite.

Equivalent environment variables still work if you prefer starting the API from a configured shell:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
PR_TRACKER_VIEWER_LOGIN=your-github-login
PR_TRACKER_LOCAL_DB_PATH=/path/to/pr-tracker.sqlite
PR_TRACKER_GITHUB_SETTINGS_PATH=/path/to/github-settings.json
```

`GITHUB_REPOSITORIES` is required when using an environment token. It keeps the
local app scoped to an explicit allow-list instead of scanning every repository
the token can access.

The token only needs read access for the current V1 reviewer inbox. A fine-grained personal access token should be scoped to the selected repositories with repository `Pull requests` read access. GitHub always includes metadata read access for selected repositories.

`PR_TRACKER_VIEWER_LOGIN` is optional because the API can call GitHub's
current-user endpoint. Set it anyway when testing against mocked or enterprise
API environments.

## Current Local Behavior

The GitHub sync path reads pull requests, requested reviewers, and submitted
reviews into SQLite. The reviewer workflow states are derived locally from the
cached deterministic data.

The "mark seen" action and board state are stored in SQLite and survive API
restarts.

No GitHub writes are made from the app in this phase. Review submission still happens in GitHub.

## Legacy Live Mode

Use `PR_TRACKER_USE_LIVE_GITHUB=true` only when you intentionally want the old
non-persistent live API path for debugging. The local-only V1 path should not
need this flag.
