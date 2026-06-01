import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReviewerInbox, WorkflowState } from "@pr-tracker/reviewer-workflow";
import { InboxTable, stateLabels } from "../ui/InboxTable";
import { getReviewerInbox } from "../api";

const sectionOrder: Array<WorkflowState | "all" | "actionable"> = [
  "all",
  "actionable",
  "needs_review",
  "updated_since_review",
  "waiting_on_author",
  "needs_thread_attention",
  "approved",
  "stale",
  "watching"
];

const actionableStates = new Set<WorkflowState>([
  "needs_review",
  "updated_since_review",
  "needs_thread_attention"
]);

export function InboxPage() {
  const inboxQuery = useQuery({
    queryKey: ["reviewer-inbox"],
    queryFn: getReviewerInbox
  });

  if (inboxQuery.isLoading) {
    return <div className="panel">Loading reviewer inbox...</div>;
  }

  if (inboxQuery.isError || !inboxQuery.data) {
    return (
      <div className="panel error">
        Could not load reviewer inbox. Check that the API is running.
      </div>
    );
  }

  return <LoadedInbox inbox={inboxQuery.data} />;
}

function LoadedInbox({ inbox }: { inbox: ReviewerInbox }) {
  const [activeSection, setActiveSection] =
    useState<(typeof sectionOrder)[number]>("actionable");
  const [query, setQuery] = useState("");
  const [onlyUnseen, setOnlyUnseen] = useState(false);
  const actorById = useMemo(
    () => new Map(inbox.actors.map((actor) => [actor.id, actor.login])),
    [inbox.actors]
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = useMemo(
    () =>
      inbox.items.filter((item) => {
        const matchesSection =
          activeSection === "all" ||
          (activeSection === "actionable"
            ? actionableStates.has(item.workflowState)
            : item.workflowState === activeSection);
        const matchesUnseen = !onlyUnseen || item.unseenActivityCount > 0;
        const searchable = [
          item.pullRequest.title,
          item.pullRequest.repository,
          String(item.pullRequest.number),
          item.reason,
          actorById.get(item.pullRequest.authorId) ?? item.pullRequest.authorId
        ]
          .join(" ")
          .toLowerCase();
        const matchesQuery =
          normalizedQuery.length === 0 || searchable.includes(normalizedQuery);

        return matchesSection && matchesUnseen && matchesQuery;
      }),
    [activeSection, actorById, inbox.items, normalizedQuery, onlyUnseen]
  );
  const actionableCount = inbox.items.filter((item) =>
    actionableStates.has(item.workflowState)
  ).length;
  const unseenCount = inbox.items.reduce(
    (total, item) => total + item.unseenActivityCount,
    0
  );

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Single-user reviewer loop</p>
          <h1>Review inbox</h1>
        </div>
        <div className="header-stats">
          <span>{inbox.items.length} active PRs</span>
          <span>{actionableCount} actionable</span>
          <span>{unseenCount} unseen events</span>
        </div>
      </header>

      <section className="panel inbox-controls" aria-label="Inbox filters">
        <div className="section-tabs">
          {sectionOrder.map((section) => {
            const count =
              section === "all"
                ? inbox.items.length
                : section === "actionable"
                  ? actionableCount
                  : inbox.sections[section].length;
            const label =
              section === "all"
                ? "All"
                : section === "actionable"
                  ? "Actionable"
                  : stateLabels[section];

            return (
              <button
                key={section}
                type="button"
                className={activeSection === section ? "active" : undefined}
                onClick={() => setActiveSection(section)}
              >
                <span>{label}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>

        <div className="filter-row">
          <label className="search-field">
            <span>Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Repository, PR, author, reason"
            />
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={onlyUnseen}
              onChange={(event) => setOnlyUnseen(event.target.checked)}
            />
            <span>Only unseen</span>
          </label>
        </div>
      </section>

      <InboxTable inbox={inbox} items={visibleItems} />
    </div>
  );
}
