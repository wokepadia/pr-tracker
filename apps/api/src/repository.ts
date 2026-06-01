import type { Actor, PullRequestItem } from "@pr-tracker/core";
import {
  sampleActors,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests
} from "@pr-tracker/core";
import {
  buildReviewerInbox,
  type ReviewerInbox
} from "@pr-tracker/reviewer-workflow";

export interface PullRequestDetail {
  pullRequest: PullRequestItem;
  actors: Actor[];
}

export interface ReviewerInboxRepository {
  getReviewerInbox(now: string): Promise<ReviewerInbox>;
  getPullRequest(id: string): Promise<PullRequestDetail | undefined>;
  markSeen(input: {
    pullRequestId: string;
    lastSeenAt: string;
  }): Promise<{ pullRequestId: string; lastSeenAt: string }>;
  close?(): Promise<void>;
}

export function createSampleRepository(): ReviewerInboxRepository {
  const lastSeenAtByPullRequestId = { ...sampleLastSeenAtByPullRequestId };
  const viewer = sampleActors.find((actor) => actor.id === "viewer");

  if (!viewer) {
    throw new Error("Sample viewer is missing.");
  }

  return {
    async getReviewerInbox(now) {
      return buildReviewerInbox({
        viewer,
        actors: sampleActors,
        pullRequests: samplePullRequests,
        now,
        lastSeenAtByPullRequestId
      });
    },

    async getPullRequest(id) {
      const pullRequest = samplePullRequests.find((item) => item.id === id);
      return pullRequest ? { pullRequest, actors: sampleActors } : undefined;
    },

    async markSeen(input) {
      lastSeenAtByPullRequestId[input.pullRequestId] = input.lastSeenAt;
      return input;
    }
  };
}

export function shouldUseDatabaseRepository(): boolean {
  return process.env.PR_TRACKER_USE_DATABASE === "true";
}
