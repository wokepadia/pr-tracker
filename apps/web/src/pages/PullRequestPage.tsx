import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPullRequest, markPullRequestSeen } from "../api";

export function PullRequestPage() {
  const { pullRequestId } = useParams({ from: "/pull-requests/$pullRequestId" });
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["pull-request", pullRequestId],
    queryFn: () => getPullRequest(pullRequestId)
  });
  const markSeenMutation = useMutation({
    mutationFn: () => markPullRequestSeen(pullRequestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] });
    }
  });

  if (detailQuery.isLoading) {
    return <div className="panel">Loading pull request...</div>;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return <div className="panel error">Could not load pull request.</div>;
  }

  const { pullRequest, actors } = detailQuery.data;
  const actorById = new Map(actors.map((actor) => [actor.id, actor.login]));

  return (
    <div className="page-stack">
      <Link to="/" className="back-link">
        Back to inbox
      </Link>

      <header className="page-header">
        <div>
          <p className="eyebrow">
            {pullRequest.repository} #{pullRequest.number}
          </p>
          <h1>{pullRequest.title}</h1>
        </div>
        <div className="header-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => markSeenMutation.mutate()}
            disabled={markSeenMutation.isPending}
          >
            {markSeenMutation.isPending ? "Marking..." : "Mark seen"}
          </button>
          <a className="button" href={pullRequest.url} target="_blank" rel="noreferrer">
            Open in GitHub
          </a>
        </div>
      </header>

      {markSeenMutation.isSuccess ? (
        <div className="panel success">Marked seen for this reviewer session.</div>
      ) : null}

      <section className="grid two">
        <div className="panel">
          <h2>Review state</h2>
          <dl className="definition-list">
            <div>
              <dt>Author</dt>
              <dd>{actorById.get(pullRequest.authorId) ?? pullRequest.authorId}</dd>
            </div>
            <div>
              <dt>Draft</dt>
              <dd>{pullRequest.isDraft ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Requested reviewers</dt>
              <dd>
                {pullRequest.requestedReviewerIds
                  .map((id) => actorById.get(id) ?? id)
                  .join(", ") || "None"}
              </dd>
            </div>
            <div>
              <dt>Latest commit</dt>
              <dd>{pullRequest.latestCommitSha}</dd>
            </div>
          </dl>
        </div>

        <div className="panel">
          <h2>Unresolved threads</h2>
          {pullRequest.threads.filter((thread) => !thread.isResolved).length === 0 ? (
            <p className="muted">No unresolved review threads.</p>
          ) : (
            <ul className="event-list">
              {pullRequest.threads
                .filter((thread) => !thread.isResolved)
                .map((thread) => (
                  <li key={thread.id}>
                    <strong>{thread.filePath ?? "Conversation"}</strong>
                    <span>
                      {thread.line ? `Line ${thread.line}` : "No line context"} ·{" "}
                      {thread.participantIds
                        .map((id) => actorById.get(id) ?? id)
                        .join(", ")}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Recent activity</h2>
        <ul className="event-list">
          {pullRequest.activity.map((event) => (
            <li key={event.id}>
              <strong>{event.title}</strong>
              <span>
                {actorById.get(event.actorId) ?? event.actorId} ·{" "}
                {new Date(event.occurredAt).toLocaleString()}
              </span>
              {event.body ? <p>{event.body}</p> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
