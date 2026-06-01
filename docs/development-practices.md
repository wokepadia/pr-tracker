# Development Practices

This project borrows several practices from Zulip's public developer documentation. The point is not to copy Zulip's full process, but to adopt the parts that fit a small, high-quality product: readable code, reviewable changes, strong tests, and careful commit history.

## Principles

- Prefer code that is readable without heavy explanation.
- Keep changes easy to review by separating unrelated ideas.
- Make behavior deterministic before making it clever.
- Treat tests, docs, and error handling as part of the change, not follow-up chores.
- Use generated or AI-assisted work only when the result is reviewed and owned by the developer.

## Reviewable Changes

Every pull request should be structured so a reviewer can understand the intended behavior, the important tradeoffs, and the risk.

Good PRs should:

- Explain the user-visible or developer-visible change.
- Call out important deviations from the original plan.
- Highlight open questions directly instead of burying uncertainty in code.
- Include screenshots or screen recordings for meaningful UI changes.
- Include testing notes that are specific enough for another developer to reproduce the important checks.
- Avoid mixing unrelated refactors, behavior changes, and cleanup in one indistinct change.

When a change contains both preparatory refactoring and feature work, prefer placing the refactoring first in the history so it can be reviewed independently.

## Code Review Checklist

Use this checklist when reviewing your own work or someone else's.

- Is the intended behavior clear from the code and tests?
- Is the domain model still independent of one specific view or workflow?
- Are invalid inputs and error paths handled close to the code that can trigger them?
- Are new abstractions justified by real complexity or reuse?
- Are docs updated when behavior, commands, setup, or workflows change?
- Are UI changes checked at relevant desktop/mobile widths?
- Are interactive controls checked for keyboard and hover/focus behavior?
- Are visual changes checked for accidental effects elsewhere?
- Are tests focused on behavior and likely failure modes rather than implementation trivia?
- Does each commit represent a coherent idea with a useful message?

## Testing Philosophy

Tests should protect the behavior that matters and make regressions cheap to diagnose.

- Add tests with the behavior they protect, in the same commit.
- Include negative tests for validation and error handling where relevant.
- Prefer tests that rule out a class of bugs over tests that only mirror one implementation detail.
- Keep network-dependent behavior behind mocks, fixtures, or adapters so tests are deterministic.
- For frontend work, test the important user path manually even when automated tests exist.
- Do not let "manual testing" mean vague confidence. Record the exact route, action, browser/viewport when relevant, and result.

## Frontend Quality

For UI work:

- Check changed surfaces in narrow and wide viewports.
- Verify loading, empty, error, and populated states.
- Keep visual patterns consistent with adjacent UI.
- Confirm text does not overflow in common and long-content cases.
- Check keyboard navigation for interactive elements.
- Include screenshots in PRs for visual changes once the app has a meaningful UI.

## Source Notes

Research sources:

- [Zulip commit discipline](https://zulip.readthedocs.io/en/latest/contributing/commit-discipline.html)
- [Zulip submitting a pull request](https://zulip.readthedocs.io/en/stable/contributing/reviewable-prs.html)
- [Zulip code reviewing guide](https://zulip.readthedocs.io/en/stable/contributing/code-reviewing.html)
- [Zulip testing overview](https://zulip.readthedocs.io/en/7.4/testing/testing.html)
- [Zulip Git usage guide](https://zulip.readthedocs.io/en/10.1/git/using.html)
