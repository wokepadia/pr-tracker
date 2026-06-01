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
  ReviewerInbox
} from "@pr-tracker/reviewer-workflow";

const columnHelper = createColumnHelper<ClassifiedPullRequest>();

const stateLabels: Record<string, string> = {
  needs_review: "Needs review",
  updated_since_review: "Updated",
  waiting_on_author: "Waiting on author",
  needs_thread_attention: "Thread attention",
  approved: "Approved",
  stale: "Stale",
  watching: "Watching",
  inactive: "Inactive"
};

export function InboxTable({ inbox }: { inbox: ReviewerInbox }) {
  const [sorting, setSorting] = useState<SortingState>([
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
    data: inbox.items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <section className="panel table-panel">
      <table>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
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
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
