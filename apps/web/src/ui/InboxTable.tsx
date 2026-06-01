import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import type {
  ClassifiedPullRequest,
  WorkflowState,
  ReviewerInbox
} from "@pr-tracker/reviewer-workflow";

const columnHelper = createColumnHelper<ClassifiedPullRequest>();
const statePriority: Record<WorkflowState, number> = {
  needs_review: 0,
  updated_since_review: 1,
  needs_thread_attention: 2,
  waiting_on_author: 3,
  approved: 4,
  stale: 5,
  watching: 6,
  inactive: 7
};

export const stateLabels: Record<string, string> = {
  needs_review: "Needs review",
  updated_since_review: "Updated",
  waiting_on_author: "Waiting on author",
  needs_thread_attention: "Thread attention",
  approved: "Approved",
  stale: "Stale",
  watching: "Watching",
  inactive: "Inactive"
};

export function InboxTable({
  inbox,
  items = inbox.items
}: {
  inbox: ReviewerInbox;
  items?: ClassifiedPullRequest[];
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "priority", desc: false },
    { id: "unseen", desc: true },
    { id: "updatedAt", desc: true }
  ]);

  const actorById = useMemo(
    () => new Map(inbox.actors.map((actor) => [actor.id, actor.login])),
    [inbox.actors]
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.workflowState, {
        id: "state",
        header: "State",
        cell: (info) => (
          <span className={`state-pill ${info.getValue()}`}>
            {stateLabels[info.getValue()]}
          </span>
        )
      }),
      columnHelper.accessor(
        (row) =>
          statePriority[row.workflowState] * 1000 -
          Math.min(row.unseenActivityCount, 999),
        {
          id: "priority",
          header: "Priority",
          cell: () => null,
          enableHiding: true
        }
      ),
      columnHelper.accessor((row) => row.pullRequest.title, {
        id: "title",
        header: "Pull request",
        cell: (info) => {
          const item = info.row.original;
          return (
            <div className="pr-title">
              <Link
                to="/pull-requests/$pullRequestId"
                params={{ pullRequestId: item.pullRequest.id }}
              >
                {item.pullRequest.title}
              </Link>
              <span>
                {item.pullRequest.repository} #{item.pullRequest.number}
              </span>
              <span>{latestActivityLine(item, actorById)}</span>
            </div>
          );
        }
      }),
      columnHelper.accessor((row) => actorById.get(row.pullRequest.authorId), {
        id: "author",
        header: "Author",
        cell: (info) => info.getValue() ?? "Unknown"
      }),
      columnHelper.accessor((row) => row.reason, {
        id: "reason",
        header: "Reason"
      }),
      columnHelper.accessor((row) => row.unseenActivityCount, {
        id: "unseen",
        header: "Unseen",
        cell: (info) => (
          <span className={info.getValue() > 0 ? "unseen" : "muted"}>
            {info.getValue()}
          </span>
        )
      }),
      columnHelper.accessor((row) => row.pullRequest.updatedAt, {
        id: "updatedAt",
        header: "Updated",
        cell: (info) => new Date(info.getValue()).toLocaleString()
      })
    ],
    [actorById]
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <section className="panel table-panel">
      {items.length === 0 ? (
        <div className="empty-state">
          <h2>No pull requests match this view</h2>
          <p>Change the section, search text, or unseen filter.</p>
        </div>
      ) : (
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers
                  .filter((header) => header.id !== "priority")
                  .map((header) => (
                    <th key={header.id}>
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        {header.column.getIsSorted() === "asc" ? " ↑" : null}
                        {header.column.getIsSorted() === "desc" ? " ↓" : null}
                      </button>
                    </th>
                  ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row
                  .getVisibleCells()
                  .filter((cell) => cell.column.id !== "priority")
                  .map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function latestActivityLine(
  item: ClassifiedPullRequest,
  actorById: Map<string, string>
): string {
  const latestActivity = [...item.pullRequest.activity].sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
  )[0];

  if (!latestActivity) {
    return "No recorded activity";
  }

  return `${actorById.get(latestActivity.actorId) ?? latestActivity.actorId}: ${
    latestActivity.title
  }`;
}
