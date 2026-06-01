import type { PullRequestItem, Actor } from "@pr-tracker/core";
import type { ReviewerInbox } from "@pr-tracker/reviewer-workflow";

export interface PullRequestDetailResponse {
  pullRequest: PullRequestItem;
  actors: Actor[];
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

export async function getReviewerInbox(): Promise<ReviewerInbox> {
  const response = await fetch(apiUrl("/api/reviewer-inbox"));
  if (!response.ok) {
    throw new Error("Failed to load reviewer inbox.");
  }

  return response.json() as Promise<ReviewerInbox>;
}

export async function getPullRequest(
  id: string
): Promise<PullRequestDetailResponse> {
  const response = await fetch(apiUrl(`/api/pull-requests/${id}`));
  if (!response.ok) {
    throw new Error("Failed to load pull request.");
  }

  return response.json() as Promise<PullRequestDetailResponse>;
}

export async function markPullRequestSeen(id: string): Promise<{
  pullRequestId: string;
  lastSeenAt: string;
}> {
  const response = await fetch(apiUrl(`/api/pull-requests/${id}/seen`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastSeenAt: new Date().toISOString() })
  });

  if (!response.ok) {
    throw new Error("Failed to mark pull request as seen.");
  }

  return response.json() as Promise<{
    pullRequestId: string;
    lastSeenAt: string;
  }>;
}
