# Project Guidance

## Required Reading

- Core product workflow: [docs/core-workflow-plan.md](docs/core-workflow-plan.md)
- Development practices: [docs/development-practices.md](docs/development-practices.md)
- Commit guidelines: [docs/commit-guidelines.md](docs/commit-guidelines.md)

## Domain Model

The underlying domain model must stay independent of the reviewer workflow and independent of any single UI view.

Model GitHub activity as reusable primitives such as actors, items, events, comments, review decisions, labels, assignments, subscriptions, timestamps, and relationships. Reviewer inboxes, issue triage views, authored-item views, future team queues, and other workflows should be derived projections over that shared model rather than separate domain models.

Do not bake view-specific states such as "needs my review" directly into the core entities. Keep those as computed classifications owned by workflow/view layers.

## V1 Product Scope

V1 is basic plumbing for a single-user reviewer inbox. Use deterministic GitHub data ingestion, event storage, and computed workflow classifications. Do not add generated summaries or other LLM-dependent features in V1.

## Development Practices Summary

Keep code readable, deterministic, and easy to review. Update tests and docs in the same change as the behavior they protect or describe. Prefer small, coherent changes over broad mixed refactors. Keep network-dependent behavior behind adapters/mocks so tests stay reliable.

## Commit Discipline Summary

Each commit should be one minimal coherent idea that can be reviewed independently. Use `area: Imperative sentence.` summaries, keep them specific, and write a body when the reasoning is non-obvious. Amend/rebase away temporary fixup commits before review; the final history should explain the codebase evolution, not the messy development path.
