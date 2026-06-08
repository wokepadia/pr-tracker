# Review Ninja

Desktop reviewer inbox for GitHub pull requests.

V1 is intentionally focused on local desktop plumbing:

- GitHub-shaped domain primitives.
- Deterministic reviewer workflow classification.
- Tauri desktop shell with Vite + React + TanStack UI.
- Local SQLite storage for GitHub cache, reviewer queue state, onboarding, and board layout.
- Tauri Stronghold storage for the GitHub token.
- Sample data fallback so the app runs before GitHub token credentials are configured.

Generated summaries, LLM-dependent ranking, CI/check-state tracking, team workflows, authored-PR management, hosted web deployment, and separate API servers are out of scope for V1.

## Stack

- pnpm workspace
- TypeScript
- Tauri
- Vite + React
- TanStack Router, Query, and Table
- SQLite through Tauri SQL
- Tauri Stronghold
- GitHub REST API token source
- Vitest

## Local Development

Install dependencies:

```sh
pnpm install
```

Launch the desktop app:

```sh
pnpm dev
```

This starts the Vite dev server used by the Tauri webview and opens the desktop app. The browser web app and separate API server are no longer part of the workspace.

Run checks:

```sh
pnpm typecheck
pnpm test
pnpm build
```

## GitHub Token Setup

Open Settings in the desktop app and enter:

- a read-only GitHub token
- one or more repositories, for example `zulip/zulip`
- your GitHub username

The desktop app stores the token in a local Tauri Stronghold vault and stores non-secret settings in the local SQLite database. The token is never returned to the UI after saving.

Equivalent environment variables are still useful for local development and tests:

```text
GITHUB_TOKEN=
GITHUB_REPOSITORIES=owner/repo,owner/another-repo
GITHUB_API_BASE_URL=https://api.github.com
GITHUB_CLOSED_LOOKBACK_DAYS=30
PR_TRACKER_VIEWER_LOGIN=your-github-login
```

A read-only fine-grained personal access token is enough for the current reviewer inbox. Scope it to the selected repositories and grant repository `Pull requests` read access. The app does not write reviews or comments in V1.

## Local Data

The desktop app syncs selected GitHub pull requests into local SQLite and derives reviewer workflow states from cached deterministic data. Board labels, card placement, pin/mute/snooze state, last-seen state, onboarding state, and column widths persist locally.

The settings page can create an unencrypted `.sqlite` backup of the local database. The backup does not include the GitHub token because tokens are stored separately from the reviewer SQLite database, but it can include repository names, pull request titles, comments, review activity, and local queue state. Store backup files accordingly.
