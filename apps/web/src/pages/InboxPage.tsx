import { useQuery } from "@tanstack/react-query";
import { InboxTable } from "../ui/InboxTable";
import { getReviewerInbox } from "../api";

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

  const inbox = inboxQuery.data;

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Single-user reviewer loop</p>
          <h1>Review inbox</h1>
        </div>
        <div className="header-stats">
          <span>{inbox.items.length} active PRs</span>
          <span>{inbox.sections.needs_review.length} requested</span>
          <span>{inbox.sections.updated_since_review.length} updated</span>
        </div>
      </header>

      <InboxTable inbox={inbox} />
    </div>
  );
}
