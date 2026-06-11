# Project Guidance

## Required Reading

- Core product workflow: [docs/core-workflow-plan.md](docs/core-workflow-plan.md)
- Reviewer UI wireframe reference: [docs/wireframe-reference.md](docs/wireframe-reference.md)
- Localhost GitHub setup: [docs/localhost-github-setup.md](docs/localhost-github-setup.md)
- Sync and loading behavior: [docs/sync-and-loading.md](docs/sync-and-loading.md)
- Development practices: [docs/development-practices.md](docs/development-practices.md)
- Commit guidelines: [docs/commit-guidelines.md](docs/commit-guidelines.md)

## UI Reference

Treat the root `Review Queue Wireframes (standalone).html` file as the canonical reviewer UI wireframe. Use [docs/wireframe-reference.md](docs/wireframe-reference.md) for how to reference it. Product and UI work should preserve the intent of that wireframe unless the user explicitly changes direction.

Design and QA for the app should target desktop use. Do not spend implementation time optimizing, testing, or making tradeoffs for mobile layouts unless the user explicitly asks for mobile support in that task.

## Domain Model

The underlying domain model must stay independent of the reviewer workflow and independent of any single UI view.

Model GitHub activity as reusable primitives such as actors, items, events, comments, review decisions, labels, assignments, subscriptions, timestamps, and relationships. Reviewer inboxes and other workflow views should be derived projections over that shared model rather than separate domain models.

Do not bake view-specific states such as "needs my review" directly into the core entities. Keep those as computed classifications owned by workflow/view layers.

## V1 Product Scope

V1 is basic plumbing for a single-user reviewer inbox. Use deterministic GitHub data ingestion, event storage, and computed workflow classifications. Do not add generated summaries or other LLM-dependent features in V1.

## Implementation Discipline

Build only for the current reviewer-loop use case. Do not add speculative future workflows, compatibility layers, fallbacks, configuration branches, abstractions, or generalized extension points unless the current phase explicitly requires them.

Keep the implementation simple, direct, and balanced: avoid unnecessary optimization, but do not ship obviously inefficient UI paths for the expected reviewer inbox size. Prefer clear data shapes, local deterministic state, and feature-sized changes that can be reviewed independently.

You may install packages when they directly simplify the current implementation. Prefer a proven package over building complex behavior by hand. Keep dependencies intentional: do not add packages for speculative future needs, and remove generated scaffolds or unused dependencies once they have served their purpose.

During UI implementation, work in feature checkpoints. For each feature checkpoint, implement the smallest coherent slice, run focused QA against the wireframe/spec, fix bugs, then do a code-review pass before committing. Do not commit half-polished UI.

## Development Practices Summary

Keep code readable, deterministic, and easy to review. Update tests and docs in the same change as the behavior they protect or describe. Prefer small, coherent changes over broad mixed refactors. Keep network-dependent behavior behind adapters/mocks so tests stay reliable.

## Commit Discipline Summary

Commit at each logical step according to the Zulip-inspired discipline in [docs/commit-guidelines.md](docs/commit-guidelines.md). Each commit should be one minimal coherent idea that can be reviewed independently. Use `area: Imperative sentence.` summaries, keep them specific, and write a body when the reasoning is non-obvious. Amend/rebase away temporary fixup commits before review; the final history should explain the codebase evolution, not the messy development path.

Agents should create these commits without asking for separate permission once a coherent checkpoint is implemented, verified, and reviewed. Do not wait for the user to prompt "commit"; keep the branch history current as work progresses. Stage only files that belong to the completed checkpoint, and leave unrelated dirty or untracked files alone.

Do not create merge commits when bringing branch work onto `main`; rebase the branch onto `main` and fast-forward `main` to the rebased tip.
