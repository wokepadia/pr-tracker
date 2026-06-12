# Desktop GitHub Setup

## Goal

Run the desktop reviewer inbox locally with real GitHub pull requests and no in-app login.

The desktop app chooses its local data source at read time:

1. Real GitHub data is synced into SQLite when local GitHub settings or
   `GITHUB_TOKEN`/`GITHUB_REPOSITORIES` are configured.
2. Sample data is seeded into SQLite when no GitHub credentials are configured.

Use a read-only personal access token for local development.

## Local SQLite Token Setup

Launch the Tauri app:

```sh
pnpm dev
```

Open Settings in the desktop app and enter:

- a read-only GitHub token
- one or more repositories, for example `zulip/zulip`
- your GitHub username

The desktop app stores the token in a local Tauri Stronghold vault and stores
the non-secret repository settings in local SQLite. The token is never returned
to the UI after saving.

Older development builds stored desktop tokens in macOS Keychain. Those tokens
are not migrated automatically because reading them can trigger repeated macOS
access prompts. Re-enter the GitHub token once in Settings to save it into the
Stronghold vault.

After settings are saved, the desktop app syncs selected GitHub pull requests
into the local SQLite database and serves the reviewer inbox from that local
cache. Board labels, card placement, pin/mute/snooze state, last-seen state, and
column widths also persist in SQLite.

Equivalent environment variables still work for local development and tests:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

`GITHUB_REPOSITORIES` is required when using an environment token. It keeps the
local app scoped to an explicit allow-list instead of scanning every repository
the token can access.

The token only needs read access for the current V1 reviewer inbox. A
fine-grained personal access token should be scoped to the selected repositories
with repository `Pull requests` read access. GitHub always includes metadata
read access for selected repositories.

`PR_TRACKER_VIEWER_LOGIN` is optional because the desktop app can call GitHub's
current-user endpoint. Set it anyway when testing against mocked or enterprise
API environments.

## Current Local Behavior

The GitHub sync path reads pull requests, requested reviewers, submitted
reviews, review-thread comments, and top-level pull request conversation
comments into SQLite. The reviewer workflow states are derived locally from the
cached deterministic data.

The "mark seen" action and board state are stored in SQLite and survive desktop
app restarts.

The settings page can create an unencrypted `.sqlite` backup of the local
database. The backup does not include the GitHub token because tokens are stored
separately from the reviewer SQLite database, but it can include repository
names, pull request titles, comments, review activity, and local queue state. You
are responsible for storing backup files safely.

No GitHub writes are made from the app in this phase. Review submission still happens in GitHub.

## Local Logs

The desktop app writes native and renderer error logs through Tauri's log plugin.
Logs are stored in the operating system's app log directory with the filename
`review-ninja.log`.

Log files are bounded to 1 MiB each and keep the 5 most recent rotated files, so
local debugging logs do not grow without limit. Renderer logging records only
error name, message, and stack strings; it does not serialize arbitrary objects
or GitHub settings payloads.
