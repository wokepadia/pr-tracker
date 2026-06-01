import type {
  Actor,
  PullRequestItem,
  ViewerContext
} from "@pr-tracker/core";
import {
  sampleActors,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests
} from "@pr-tracker/core";

export type WorkflowState =
  | "needs_review"
  | "updated_since_review"
  | "waiting_on_author"
  | "needs_thread_attention"
  | "approved"
  | "stale"
  | "watching"
  | "inactive";

export interface ClassifiedPullRequest {
  pullRequest: PullRequestItem;
  workflowState: WorkflowState;
  reason: string;
  lastSeenAt?: string;
  unseenActivityCount: number;
}

export interface ReviewerInbox {
  viewer: Actor;
  actors: Actor[];
  items: ClassifiedPullRequest[];
  sections: Record<WorkflowState, ClassifiedPullRequest[]>;
}

const activeStates: WorkflowState[] = [
  "needs_review",
  "updated_since_review",
  "waiting_on_author",
  "needs_thread_attention",
  "approved",
  "stale",
  "watching",
  "inactive"
];

export function classifyPullRequest(
  pullRequest: PullRequestItem,
  viewer: ViewerContext
): ClassifiedPullRequest {
  const lastSeenAt = viewer.lastSeenAtByPullRequestId[pullRequest.id];
  const unseenActivityCount = countUnseenActivity(pullRequest, lastSeenAt);

  if (pullRequest.state !== "open") {
    return {
      pullRequest,
      workflowState: "inactive",
      reason: "This pull request is no longer open.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (pullRequest.isDraft) {
    return {
      pullRequest,
      workflowState: "watching",
      reason: "This pull request is still a draft.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  const viewerReviews = pullRequest.reviews
    .filter((review) => review.reviewerId === viewer.viewerId)
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const latestViewerReview = viewerReviews[0];
  const hasKnownReviewedHead =
    typeof latestViewerReview?.commitSha === "string" &&
    latestViewerReview.commitSha.length > 0;
  const reviewedDifferentHead =
    hasKnownReviewedHead &&
    latestViewerReview.commitSha !== pullRequest.latestCommitSha;
  const hasOpenViewerThread = pullRequest.threads.some(
    (thread) => !thread.isResolved && thread.participantIds.includes(viewer.viewerId)
  );

  if (latestViewerReview?.decision === "changes_requested") {
    if (reviewedDifferentHead) {
      return {
        pullRequest,
        workflowState: "updated_since_review",
        reason: "The author pushed commits after your requested changes.",
        lastSeenAt,
        unseenActivityCount
      };
    }

    return {
      pullRequest,
      workflowState: "waiting_on_author",
      reason: hasKnownReviewedHead
        ? "You requested changes and the author has not pushed since."
        : "You requested changes; the reviewed commit is unknown.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (pullRequest.requestedReviewerIds.includes(viewer.viewerId)) {
    return {
      pullRequest,
      workflowState: "needs_review",
      reason: "You are requested as a reviewer.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (latestViewerReview && reviewedDifferentHead) {
    return {
      pullRequest,
      workflowState: "updated_since_review",
      reason: "New commits were pushed after your last review.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (hasOpenViewerThread) {
    return {
      pullRequest,
      workflowState: "needs_thread_attention",
      reason: "An unresolved review thread includes you.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (latestViewerReview?.decision === "approved") {
    return {
      pullRequest,
      workflowState: "approved",
      reason: "You already approved this pull request.",
      lastSeenAt,
      unseenActivityCount
    };
  }

  if (isStale(pullRequest.updatedAt, viewer.now, viewer.staleAfterDays)) {
    return {
      pullRequest,
      workflowState: "stale",
      reason: `No activity for ${viewer.staleAfterDays} days.`,
      lastSeenAt,
      unseenActivityCount
    };
  }

  return {
    pullRequest,
    workflowState: "watching",
    reason: "No reviewer action is currently required.",
    lastSeenAt,
    unseenActivityCount
  };
}

export function buildReviewerInbox(input: {
  viewer: Actor;
  actors: Actor[];
  pullRequests: PullRequestItem[];
  now: string;
  staleAfterDays?: number;
  lastSeenAtByPullRequestId?: Record<string, string | undefined>;
}): ReviewerInbox {
  const viewerContext: ViewerContext = {
    viewerId: input.viewer.id,
    now: input.now,
    staleAfterDays: input.staleAfterDays ?? 7,
    lastSeenAtByPullRequestId: input.lastSeenAtByPullRequestId ?? {}
  };

  const items = input.pullRequests
    .map((pullRequest) => classifyPullRequest(pullRequest, viewerContext))
    .filter((item) => item.workflowState !== "inactive")
    .sort(compareClassifiedPullRequests);

  const sections = Object.fromEntries(
    activeStates.map((state) => [
      state,
      items.filter((item) => item.workflowState === state)
    ])
  ) as Record<WorkflowState, ClassifiedPullRequest[]>;

  return {
    viewer: input.viewer,
    actors: input.actors,
    items,
    sections
  };
}

export function buildSampleInbox(now = "2026-06-01T12:00:00.000Z"): ReviewerInbox {
  const viewer = sampleActors.find((actor) => actor.id === "viewer");
  if (!viewer) {
    throw new Error("Sample viewer is missing.");
  }

  return buildReviewerInbox({
    viewer,
    actors: sampleActors,
    pullRequests: samplePullRequests,
    now,
    lastSeenAtByPullRequestId: sampleLastSeenAtByPullRequestId
  });
}

function countUnseenActivity(
  pullRequest: PullRequestItem,
  lastSeenAt: string | undefined
): number {
  if (!lastSeenAt) {
    return pullRequest.activity.length;
  }

  const lastSeenTime = Date.parse(lastSeenAt);
  return pullRequest.activity.filter(
    (event) => Date.parse(event.occurredAt) > lastSeenTime
  ).length;
}

function compareClassifiedPullRequests(
  a: ClassifiedPullRequest,
  b: ClassifiedPullRequest
): number {
  const stateDelta = stateRank(a.workflowState) - stateRank(b.workflowState);
  if (stateDelta !== 0) {
    return stateDelta;
  }

  return (
    Date.parse(b.pullRequest.updatedAt) - Date.parse(a.pullRequest.updatedAt)
  );
}

function stateRank(state: WorkflowState): number {
  return activeStates.indexOf(state);
}

function isStale(updatedAt: string, now: string, staleAfterDays: number): boolean {
  const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000;
  return Date.parse(now) - Date.parse(updatedAt) >= staleAfterMs;
}
