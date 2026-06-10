import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecisionEvent,
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
  | "caught_up"
  | "stale"
  | "watching"
  | "inactive";

export type TurnOwner = "viewer" | "author" | "none";

export interface TurnState {
  owner: TurnOwner;
  /**
   * When the current owner received the turn. Undefined when no ingested
   * event anchors the hand-off, so consumers can fall back honestly
   * instead of displaying a made-up wait time.
   */
  since?: string;
}

export interface ClassificationEvidence {
  id: string;
  label: string;
  occurredAt?: string;
  actorId?: string;
}

export interface ClassifiedPullRequest {
  pullRequest: PullRequestItem;
  workflowState: WorkflowState;
  reason: string;
  turn: TurnState;
  evidence: ClassificationEvidence[];
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
  "caught_up",
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

  const make = (
    workflowState: WorkflowState,
    reason: string,
    turn: TurnState,
    evidence: ClassificationEvidence[]
  ): ClassifiedPullRequest => ({
    pullRequest,
    workflowState,
    reason,
    turn,
    evidence,
    lastSeenAt,
    unseenActivityCount
  });

  if (pullRequest.state !== "open") {
    return make(
      "inactive",
      "This pull request is no longer open.",
      { owner: "none", since: pullRequest.updatedAt },
      [
        {
          id: "closed",
          label: `This pull request was ${pullRequest.state}.`,
          occurredAt: pullRequest.updatedAt
        }
      ]
    );
  }

  if (pullRequest.isDraft) {
    const draftEvent = latestActivityOfType(pullRequest, "converted_to_draft");
    return make(
      "watching",
      "This pull request is still a draft.",
      { owner: "author", since: draftEvent?.occurredAt ?? pullRequest.createdAt },
      [
        {
          id: "draft",
          label: "The author is still preparing this draft.",
          occurredAt: draftEvent?.occurredAt ?? pullRequest.createdAt,
          actorId: pullRequest.authorId
        }
      ]
    );
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
  const isCaughtUpWithLatestActivity =
    unseenActivityCount === 0 && isSeenAtOrAfterUpdate(lastSeenAt, pullRequest.updatedAt);
  const openViewerThreads = pullRequest.threads.filter(
    (thread) => !thread.isResolved && thread.participantIds.includes(viewer.viewerId)
  );

  if (latestViewerReview?.decision === "changes_requested") {
    if (reviewedDifferentHead) {
      const pushEvidence = buildPushedAfterReviewEvidence(
        pullRequest,
        latestViewerReview
      );

      if (isCaughtUpWithLatestActivity) {
        return make(
          "caught_up",
          "You marked the latest author activity caught up.",
          { owner: "none", since: lastSeenAt },
          [
            reviewEvidence(latestViewerReview, viewer.viewerId),
            pushEvidence,
            caughtUpEvidence(lastSeenAt)
          ]
        );
      }

      return make(
        "updated_since_review",
        "The author pushed commits after your requested changes.",
        { owner: "viewer", since: pushEvidence.occurredAt },
        [reviewEvidence(latestViewerReview, viewer.viewerId), pushEvidence]
      );
    }

    return make(
      "waiting_on_author",
      hasKnownReviewedHead
        ? "You requested changes and the author has not pushed since."
        : "You requested changes; the reviewed commit is unknown.",
      { owner: "author", since: latestViewerReview.submittedAt },
      [
        reviewEvidence(latestViewerReview, viewer.viewerId),
        {
          id: "no_push",
          label: hasKnownReviewedHead
            ? "The author has not pushed since your review."
            : "The commit you reviewed is unknown, so pushes cannot be detected.",
          actorId: pullRequest.authorId
        }
      ]
    );
  }

  if (pullRequest.requestedReviewerIds.includes(viewer.viewerId)) {
    const requestEvent = latestActivityOfType(pullRequest, "review_request");
    return make(
      "needs_review",
      "You are requested as a reviewer.",
      { owner: "viewer", since: requestEvent?.occurredAt },
      [
        {
          id: "requested",
          label: "Your review was requested.",
          occurredAt: requestEvent?.occurredAt,
          actorId: requestEvent?.actorId
        }
      ]
    );
  }

  if (latestViewerReview && reviewedDifferentHead) {
    const pushEvidence = buildPushedAfterReviewEvidence(
      pullRequest,
      latestViewerReview
    );

    if (isCaughtUpWithLatestActivity) {
      return make(
        "caught_up",
        "You marked the latest author activity caught up.",
        { owner: "none", since: lastSeenAt },
        [
          reviewEvidence(latestViewerReview, viewer.viewerId),
          pushEvidence,
          caughtUpEvidence(lastSeenAt)
        ]
      );
    }

    return make(
      "updated_since_review",
      "New commits were pushed after your last review.",
      { owner: "viewer", since: pushEvidence.occurredAt },
      [reviewEvidence(latestViewerReview, viewer.viewerId), pushEvidence]
    );
  }

  if (openViewerThreads.length > 0) {
    const latestThreadActivityAt = maxIsoDate(
      openViewerThreads.map((thread) => thread.lastActivityAt)
    );
    return make(
      "needs_thread_attention",
      "An unresolved review thread includes you.",
      { owner: "viewer", since: latestThreadActivityAt },
      [
        {
          id: "open_threads",
          label:
            openViewerThreads.length === 1
              ? "1 unresolved review thread includes you."
              : `${openViewerThreads.length} unresolved review threads include you.`,
          occurredAt: latestThreadActivityAt
        }
      ]
    );
  }

  if (latestViewerReview?.decision === "approved") {
    return make(
      "approved",
      "You already approved this pull request.",
      { owner: "none", since: latestViewerReview.submittedAt },
      [reviewEvidence(latestViewerReview, viewer.viewerId)]
    );
  }

  if (isStale(pullRequest.updatedAt, viewer.now, viewer.staleAfterDays)) {
    return make(
      "stale",
      `No activity for ${viewer.staleAfterDays} days.`,
      { owner: "none", since: pullRequest.updatedAt },
      [
        {
          id: "stale",
          label: `Nothing has happened here for at least ${viewer.staleAfterDays} days.`,
          occurredAt: pullRequest.updatedAt
        }
      ]
    );
  }

  return make(
    "watching",
    "No reviewer action is currently required.",
    { owner: "none", since: pullRequest.updatedAt },
    [
      {
        id: "watching",
        label: "No reviewer action is currently required."
      }
    ]
  );
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

function reviewEvidence(
  review: ReviewDecisionEvent,
  viewerId: string
): ClassificationEvidence {
  const label =
    review.decision === "approved"
      ? "You approved this pull request."
      : review.decision === "changes_requested"
        ? "You requested changes."
        : "You reviewed this pull request.";

  return {
    id: "your_review",
    label,
    occurredAt: review.submittedAt,
    actorId: viewerId
  };
}

function caughtUpEvidence(lastSeenAt: string | undefined): ClassificationEvidence {
  return {
    id: "caught_up",
    label: "You marked this pull request caught up.",
    occurredAt: lastSeenAt
  };
}

function buildPushedAfterReviewEvidence(
  pullRequest: PullRequestItem,
  review: ReviewDecisionEvent
): ClassificationEvidence {
  const reviewTime = Date.parse(review.submittedAt);
  const commitsAfterReview = pullRequest.activity
    .filter(
      (event) =>
        event.type === "commit" && Date.parse(event.occurredAt) > reviewTime
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const firstCommitAfterReview = commitsAfterReview[0];

  return {
    id: "pushed_after_review",
    label:
      commitsAfterReview.length > 0
        ? commitsAfterReview.length === 1
          ? "The author pushed 1 commit after your review."
          : `The author pushed ${commitsAfterReview.length} commits after your review.`
        : "New commits were pushed after your review.",
    occurredAt: firstCommitAfterReview?.occurredAt,
    actorId: firstCommitAfterReview?.actorId ?? pullRequest.authorId
  };
}

function latestActivityOfType(
  pullRequest: PullRequestItem,
  type: PullRequestActivity["type"]
): PullRequestActivity | undefined {
  return pullRequest.activity
    .filter((event) => event.type === type)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
}

function maxIsoDate(isoDates: string[]): string | undefined {
  let latest: string | undefined;
  for (const isoDate of isoDates) {
    const time = Date.parse(isoDate);
    if (Number.isNaN(time)) continue;
    if (!latest || time > Date.parse(latest)) {
      latest = isoDate;
    }
  }
  return latest;
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

function isSeenAtOrAfterUpdate(
  lastSeenAt: string | undefined,
  updatedAt: string
): boolean {
  if (!lastSeenAt) return false;

  const lastSeenTime = Date.parse(lastSeenAt);
  const updatedTime = Date.parse(updatedAt);

  return (
    !Number.isNaN(lastSeenTime) &&
    !Number.isNaN(updatedTime) &&
    lastSeenTime >= updatedTime
  );
}
