# Commit Guidelines

This project follows a Zulip-inspired commit style: each commit should be a minimal, coherent, reviewable idea with a message that explains the change to future developers.

## Core Rule

Each commit must represent one coherent idea.

A coherent commit:

- Builds and passes the relevant tests.
- Does not knowingly leave the application in a worse state.
- Includes the tests needed for the behavior it changes.
- Includes error handling for the behavior it introduces.
- Includes docs updates when the user or developer workflow changes.
- Can be deployed independently, unless the commit message clearly explains why it is intentionally not independently deployable.

Avoid commits that only fix mistakes from earlier commits in the same branch. Amend or rebase so the final history tells the clean story of the change.

## Commit Size

Prefer smaller commits when a change can be split by meaning.

Split commits when:

- A refactor supports a later behavior change.
- Code is moved between files.
- Two unrelated refactors happen near each other.
- Two features or product behaviors are being added.
- The commit message starts to read like a list of unrelated work.

Do not split so aggressively that the history becomes noise. A brand-new feature can be one coherent commit if its pieces do not make sense independently and the result is still reviewable.

## Commit Message Format

Use this format:

```text
area: Change behavior in imperative mood.

Explain why this change is needed and how it works, when the summary is
not enough. Include tradeoffs, safety notes, testing notes, or migration
details that a future developer should know.

Fixes #123.
```

The summary line has two parts:

- `area`: one or two lowercase words naming the part of the project changed.
- Summary sentence: a concise imperative sentence describing the change.

Examples:

```text
model: Add review decision events.
docs: Document reviewer inbox state rules.
github: Store pull request review requests.
ui: Show unresolved review threads.
tests: Cover waiting-on-author classification.
```

## Summary Line Rules

- Keep the full summary line at or below 72 characters when practical.
- Start the summary sentence with an imperative verb: `Add`, `Change`, `Store`, `Remove`, `Fix`.
- Use proper capitalization and punctuation after the `area:` prefix.
- Avoid vague areas like `misc`, `fix`, `bug`, or `refactor`.
- Avoid filler like `update tests/docs` when those are expected parts of the change.
- Make the summary understandable to someone familiar with the project but not with your current task.

## Body Guidelines

Write a body when the commit is non-trivial.

Use the body to explain:

- Why the change is needed.
- Why this approach is safe or preferable.
- What assumptions the implementation depends on.
- What alternatives were considered and rejected, if important.
- What testing was done.
- Any intentional limitation or follow-up that affects future work.

Do not use the body for personal narrative, discarded debugging paths, or a chronological diary of development. If the body is trying to explain several unrelated changes, split the commit.

## Issue References

When a commit fully resolves an issue, put the closing reference in the final paragraph:

```text
Fixes #123.
```

If the change only handles part of an issue, avoid phrases that GitHub may auto-close incorrectly. Use language like:

```text
Fixes part of #123.
```

## Fixing History

Before a PR is ready for review:

- Squash temporary "fix typo", "fix tests", or "address review" commits into the commit that introduced the relevant behavior.
- Reorder commits so preparatory refactors come before the behavior that depends on them.
- Make sure every commit passes the relevant tests, or clearly explains why it cannot.
- Keep the final history focused on the product/code evolution, not on the path taken while developing.

## Review Expectations

Reviewers should check commit history as part of review.

Reject or request cleanup when:

- One commit mixes unrelated behavior.
- A commit changes behavior without corresponding tests.
- A message does not explain a non-obvious design choice.
- A later commit repairs an avoidable mistake from an earlier commit in the same branch.
- The summary line is too vague to be useful in `git log`.

## Source Notes

Research sources:

- [Zulip commit discipline](https://zulip.readthedocs.io/en/latest/contributing/commit-discipline.html)
- [Zulip Git usage guide](https://zulip.readthedocs.io/en/10.1/git/using.html)
- [Zulip submitting a pull request](https://zulip.readthedocs.io/en/stable/contributing/reviewable-prs.html)
