# Onboarding Flow Plan

## Purpose

Add a first-run onboarding flow for the local reviewer inbox. The flow should
explain what Review Ninja does, explain the local token storage boundary, show
the core reviewer workflow at a high level, and then collect the minimum GitHub
settings needed to sync real pull requests.

The onboarding must stay aligned with the current V1 product scope:

- Single-user reviewer inbox.
- Deterministic GitHub ingestion and local workflow classification.
- No LLM summaries.
- No in-app review submission.
- Review and commenting still happen in GitHub.
- GitHub token storage remains outside SQLite and outside the browser.

## Research Notes

These points should guide the implementation:

- Keep first-run content short, benefit-focused, and skippable. Microsoft first
  run guidance recommends a concise experience, clear next actions, flexibility
  to skip or revisit, and avoiding irrelevant callouts:
  <https://learn.microsoft.com/en-us/office/dev/add-ins/design/first-run-experience-patterns>
- Use progressive disclosure. NN/g describes progressive disclosure as showing
  only the most important options first and deferring specialized choices until
  users ask for them:
  <https://www.nngroup.com/articles/progressive-disclosure/>
- Do not make setup feel like a long wizard. UIGuides warns that front-loading a
  large setup sequence before value is a barrier rather than onboarding:
  <https://www.uxguides.com/guides/how-to-design-onboarding-flows>
- Make onboarding optional and contextual. Fluent 2 emphasizes relevant,
  non-distracting, optional, benefit-focused onboarding, plus clear expectations
  about what the user is about to do:
  <https://fluent2.microsoft.design/onboarding/>
- Treat tokens like passwords and prefer fine-grained, least-privilege tokens.
  GitHub recommends fine-grained personal access tokens because they can be
  restricted to specific repositories and permissions:
  <https://docs.github.com/en/enterprise-server@latest/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>
- Store secrets in a designated secret store and apply least privilege. OWASP
  secrets guidance emphasizes fine-grained controls, rotation/revocation, and
  never logging plaintext secrets:
  <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>

## Product Decision

Use a two-part first-run experience:

1. Optional, non-interactive intro carousel with four informational slides.
2. Required setup form, unless the user chooses sample data.

The carousel has only navigation controls: Back, Next, Skip intro, and Continue.
It does not ask questions, branch, run checks, open GitHub, or collect data. The
setup form is the first data-entry surface.

Skipping the intro should not skip required setup. It should jump directly to
the setup form. The setup form should offer a secondary "Use sample data" action
so the user can enter the app without real GitHub credentials.

## First-Run Trigger

Show onboarding when both are true:

- The local onboarding completion flag is absent.
- GitHub settings are not usable for real sync.

Recommended persisted state:

- `onboarding.completedAt`: user finished intro plus setup, or chose sample
  data.
- `onboarding.introSkippedAt`: user skipped only the slide carousel.
- `onboarding.version`: current onboarding content version, initially `1`.

Store onboarding state through the same local SQLite `app_settings` surface used
by desktop GitHub settings. Do not use browser-only `localStorage` as the
durable source for desktop V1.

## Information Architecture

Routes:

- `/onboarding`: first-run flow.
- `/settings`: existing editable GitHub settings screen.
- `/`: reviewer inbox.

Routing behavior:

- App start loads GitHub settings status and onboarding status.
- If onboarding is needed, redirect `/` to `/onboarding`.
- If the user completes setup, mark onboarding complete and navigate to `/`.
- If the user skips intro, remain on `/onboarding` but show setup step.
- If the user chooses sample data, mark onboarding complete and navigate to `/`.
- Settings remains reachable from the app header after onboarding.

Revisit behavior:

- Add a small "View onboarding" link from Settings after first-run completion.
- Revisiting onboarding must not reset GitHub settings.
- Revisiting onboarding should show the intro slides first, with a "Back to
  settings" exit.

## Slides

Keep the slides short and dense. Each slide should have one headline, one short
paragraph, and two or three compact facts. Avoid marketing language.

### Slide 1: What Review Ninja Is

Headline: `A reviewer inbox for GitHub pull requests`

Body:
`Review Ninja helps you decide which pull requests need your attention without opening every GitHub tab.`

Facts:

- Groups PRs by reviewer action state.
- Shows why each PR is in your queue.
- Sends you to GitHub when it is time to review code.

### Slide 2: What The App Looks At

Headline: `It reads review activity, not code intent`

Body:
`The app syncs GitHub facts like review requests, submitted reviews, comments, commits, and thread state. It uses those facts to compute deterministic queue placement.`

Facts:

- No generated summaries in V1.
- No approving, commenting, or requesting changes from the app.
- Local state tracks what you have seen, pinned, muted, or snoozed.

### Slide 3: How Your Token Is Stored

Headline: `Your token stays out of the browser`

Body:
`Use a read-only GitHub token scoped to the repositories you choose. The saved token is stored in the operating system keychain. Repository names and viewer settings are stored separately as local app configuration.`

Facts:

- Token is never returned to the browser after saving.
- Token is not stored in SQLite.
- The app only needs read access for the reviewer inbox.

### Slide 4: What You Need To Continue

Headline: `Three details start the sync`

Body:
`You will enter a read-only token, the repositories to track, and your GitHub username. After saving, the app syncs selected PRs into the local cache.`

Facts:

- Token: fine-grained personal access token preferred.
- Repositories: comma-separated `owner/repo` names.
- Username: used to classify "needs my review."

## Setup Form

The setup form should reuse the current settings fields with first-run copy and
more explicit token guidance.

Required fields:

- `Read-only GitHub token`
- `Repositories`

Optional fields:

- `Your GitHub username`
- `GitHub API base URL`

Field behavior:

- Token input uses `type="password"` and `autoComplete="off"`.
- Repositories are comma-separated `owner/repo` names.
- Viewer username can be omitted because the desktop app can fetch the current
  user from GitHub, but the form should recommend entering it for predictable
  local classification.
- GitHub API base URL is hidden behind an "Advanced" disclosure. Default is GitHub.com.
- Form-level error messages should be specific and actionable.

Primary action:

- `Save and sync`

Secondary actions:

- `Use sample data`
- `Back`

Post-save behavior:

- Save token and settings through the desktop GitHub settings adapter.
- Clear the token input immediately after successful save.
- Mark onboarding complete.
- Invalidate GitHub settings and reviewer inbox queries.
- Navigate to the inbox with a lightweight syncing/loading state.

## Security Copy Requirements

Use direct security language without overclaiming.

Say:

- `Stored in Tauri Stronghold.`
- `Repository settings are stored in local SQLite.`
- `The token is never returned to the UI after saving.`
- `Use a fine-grained token scoped to only the repositories you track.`

Do not say:

- `Encrypted by Review Ninja` unless the app owns that encryption.
- `We cannot access your token` because the local app process reads it to call
  GitHub.
- `Zero trust`, `bank-grade`, or other vague security claims.
- `OAuth` unless the implementation changes away from personal access tokens.

## Required GitHub Token Guidance

Show this compact guidance near the token field:

```text
Recommended token: fine-grained personal access token.
Repository access: only the repositories listed below.
Repository permissions: Pull requests read.
Metadata read access is included by GitHub.
```

Include a link to GitHub's token page:

<https://github.com/settings/personal-access-tokens>

If the user enters a classic token, the app should not block it in V1, but the
copy should continue to recommend fine-grained tokens.

## Desktop Wireframes

Target desktop first. The flow should feel like the existing reviewer app:
compact, practical, and quiet. Keep card radius at 8px or less and do not nest
cards inside cards.

### Slide Layout

```text
+------------------------------------------------------------------------------+
| Review Ninja                                        Skip intro                |
+------------------------------------------------------------------------------+
|                                                                              |
|  +------------------------------------+  +----------------------------------+ |
|  | Step 1 of 4                        |  | Preview: reviewer inbox         | |
|  |                                    |  |                                  | |
|  | A reviewer inbox for GitHub        |  | Needs your review               | |
|  | pull requests                      |  | +----------------------------+   | |
|  |                                    |  | | owner/repo #124             |   | |
|  | Review Ninja helps you decide      |  | | You are requested           |   | |
|  | which pull requests need your      |  | +----------------------------+   | |
|  | attention without opening every    |  |                                  | |
|  | GitHub tab.                        |  | Quick peek                       | |
|  |                                    |  | Why this needs attention         | |
|  | - Groups PRs by action state       |  | What changed recently            | |
|  | - Shows why each PR appears        |  | Open in GitHub                   | |
|  | - Hands off review to GitHub       |  |                                  | |
|  |                                    |  +----------------------------------+ |
|  | [1] [ ] [ ] [ ]                    |                                      |
|  |                                    |                                      |
|  | [Back]                       [Next]|                                      |
|  +------------------------------------+                                      |
|                                                                              |
+------------------------------------------------------------------------------+
```

Notes:

- Preview panel should be a static illustration built with existing UI tokens,
  not a live embedded inbox.
- Keep copy in the left content area; the right preview reinforces the concept.
- `Skip intro` is available on every slide.
- Back is disabled on slide 1.

### Token Storage Slide Variation

```text
+------------------------------------------------------------------------------+
| Review Ninja                                        Skip intro                |
+------------------------------------------------------------------------------+
|                                                                              |
|  +------------------------------------+  +----------------------------------+ |
|  | Step 3 of 4                        |  | Local storage boundary          | |
|  |                                    |  |                                  | |
|  | Your token stays out of the        |  | GitHub token                    | |
|  | browser                            |  | +----------------------------+   | |
|  |                                    |  | | OS keychain                |   | |
|  | Use a read-only GitHub token       |  | +----------------------------+   | |
|  | scoped to the repositories you     |  |                                  | |
|  | choose. The saved token is stored  |  | Repository list                 | |
|  | in the operating system keychain.  |  | +----------------------------+   | |
|  |                                    |  | | Local app config           |   | |
|  | - Not returned after saving        |  | +----------------------------+   | |
|  | - Not stored in SQLite             |  |                                  | |
|  | - Read access only for V1          |  | PR cache and board state        | |
|  |                                    |  | +----------------------------+   | |
|  | [ ] [ ] [3] [ ]                    |  | | Local SQLite cache         |   | |
|  |                                    |  | +----------------------------+   | |
|  | [Back]                       [Next]|  |                                  | |
|  +------------------------------------+  +----------------------------------+ |
|                                                                              |
+------------------------------------------------------------------------------+
```

### Setup Form

```text
+------------------------------------------------------------------------------+
| Review Ninja                                                                  |
+------------------------------------------------------------------------------+
|                                                                              |
|  +------------------------------------------------------------------------+  |
|  | Local GitHub access                                                    |  |
|  |                                                                        |  |
|  | Connect the repositories you review. The token is saved in the          |  |
|  | operating system keychain and is not returned after saving.             |  |
|  |                                                                        |  |
|  | Read-only GitHub token                                                 |  |
|  | +--------------------------------------------------------------------+ |  |
|  | | github_pat_...                                                     | |  |
|  | +--------------------------------------------------------------------+ |  |
|  | Recommended: fine-grained token, selected repos, Pull requests read.    |  |
|  |                                                                        |  |
|  | Repositories                                                           |  |
|  | +--------------------------------------------------------------------+ |  |
|  | | owner/repo, owner/another-repo                                     | |  |
|  | +--------------------------------------------------------------------+ |  |
|  | Use comma-separated owner/repo names.                                  |  |
|  |                                                                        |  |
|  | Your GitHub username                                                   |  |
|  | +--------------------------------------------------------------------+ |  |
|  | | your-github-login                                                  | |  |
|  | +--------------------------------------------------------------------+ |  |
|  | Used to classify pull requests that need your review.                  |  |
|  |                                                                        |  |
|  | > Advanced                                                             |  |
|  |                                                                        |  |
|  | [Use sample data]                                      [Save and sync]  |  |
|  +------------------------------------------------------------------------+  |
|                                                                              |
+------------------------------------------------------------------------------+
```

### Setup Success And Syncing

```text
+------------------------------------------------------------------------------+
| Review Ninja                                                                  |
+------------------------------------------------------------------------------+
|                                                                              |
|  +------------------------------------------------------------------------+  |
|  | GitHub settings saved                                                  |  |
|  |                                                                        |  |
|  | The inbox is syncing selected pull requests into the local cache.       |  |
|  |                                                                        |  |
|  | Token saved        macOS Keychain                                      |  |
|  | Repositories       owner/repo, owner/another-repo                      |  |
|  | Viewer             your-github-login                                   |  |
|  |                                                                        |  |
|  | [Open inbox]                                                           |  |
|  +------------------------------------------------------------------------+  |
|                                                                              |
+------------------------------------------------------------------------------+
```

## Implementation Checkpoints

### 1. Add Onboarding State Contract

- Add desktop methods to read and write onboarding state.
- Keep the state independent from GitHub credentials.
- Add tests for default missing state, saving completion, and preserving existing
  GitHub settings.

Verification:

- Typecheck passes.
- Desktop data tests cover read/write state.
- No token is included in onboarding state responses.

### 2. Add First-Run Routing Gate

- Add `/onboarding` route.
- Add a small route guard in the app shell after settings status loads.
- Avoid redirect loops when the current route is `/settings` or `/onboarding`.
- Preserve direct `/settings` access for recovery when onboarding has a bug.

Verification:

- Fresh state opens onboarding.
- Configured state opens inbox.
- Settings remains reachable.

### 3. Build Non-Interactive Slide Carousel

- Implement static slides using local copy from this document.
- Include Back, Next, Continue, and Skip intro controls.
- Store `introSkippedAt` only when the user skips the slides.
- Keep keyboard focus predictable between slide changes.

Verification:

- Slide count and progress indicators are correct.
- Skip intro goes to setup form.
- Continue from final slide goes to setup form.
- No data is collected in the carousel.

### 4. Convert Settings Form Into Shared Setup Component

- Extract the form body from `SettingsPage`.
- Reuse it in onboarding with first-run headings and actions.
- Hide GitHub API base URL behind an advanced disclosure in onboarding.
- Keep existing settings page behavior intact.

Verification:

- Existing `/settings` tests still pass.
- Saving settings from onboarding stores the token and repositories.
- Token input clears after save.
- Invalid repositories show the desktop validation error.

### 5. Add Sample Data Exit

- Add a secondary onboarding action to finish without GitHub settings.
- Mark onboarding complete and route to inbox.
- Ensure the inbox uses existing sample data behavior when no token is
  configured.

Verification:

- Fresh user can reach populated sample inbox without a token.
- Settings badge still says token is not configured.

### 6. Add Focused QA

Desktop QA targets:

- 1280px wide browser viewport.
- 1440px wide browser viewport.
- Tauri desktop shell if available.

Manual checks:

- First launch shows slide 1.
- Skip intro reaches setup.
- Back/Next controls work.
- Setup save reaches inbox.
- Sample data reaches inbox.
- `/settings` can revisit onboarding without clearing settings.
- Long repository lists do not overflow the setup form.
- Token storage copy matches actual storage status.

Automated checks:

- Desktop onboarding-state tests.
- React component tests for routing decisions.
- Form save mutation test for onboarding success.

## Open Questions

- Should `Use sample data` mark onboarding complete permanently, or should the
  inbox continue to show a small setup reminder until a token is saved?
- Should onboarding completion be versioned so future major onboarding changes
  can be shown once to existing users?
- Should a failed first sync keep the user on onboarding, or route to inbox with
  a settings error state? The pragmatic V1 answer is to route to inbox if
  settings save succeeds, then show sync errors in the app.
