import type { Actor } from "@pr-tracker/core";
import {
  sampleActors,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests
} from "@pr-tracker/core";
import {
  buildReviewerInbox,
  type ClassifiedPullRequest,
  type ReviewerInbox
} from "@pr-tracker/reviewer-workflow";

export interface PullRequestDetail {
  viewer: Actor;
  actors: Actor[];
  item: ClassifiedPullRequest;
}

export interface ReviewerInboxOptions {
  githubSearchQuery?: string;
}

export interface BoardState {
  buckets: Array<{ id: string; label: string }>;
  localQueueState: Partial<Record<
    string,
    {
      snoozed?: boolean;
      pinned?: boolean;
      muted?: boolean;
      bucketId?: string;
      notes?: string;
    }
  >>;
  userBucketItemOrder: Record<string, string[]>;
  bucketColumnWidths: Record<string, number>;
}

export interface ReviewerInboxRepository {
  getReviewerInbox(now: string, options?: ReviewerInboxOptions): Promise<ReviewerInbox>;
  getPullRequest(id: string): Promise<PullRequestDetail | undefined>;
  markSeen(input: {
    pullRequestId: string;
    lastSeenAt: string;
  }): Promise<{ pullRequestId: string; lastSeenAt: string } | undefined>;
  getBoardState?(): Promise<BoardState>;
  saveBoardState?(state: BoardState): Promise<BoardState>;
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
      if (!pullRequest) {
        return undefined;
      }

      const inbox = buildReviewerInbox({
        viewer,
        actors: sampleActors,
        pullRequests: [pullRequest],
        now: new Date().toISOString(),
        lastSeenAtByPullRequestId
      });
      const item = inbox.items[0];

      return item
        ? {
            viewer,
            actors: sampleActors,
            item
          }
        : undefined;
    },

    async markSeen(input) {
      const pullRequest = samplePullRequests.find(
        (item) => item.id === input.pullRequestId
      );
      if (!pullRequest) {
        return undefined;
      }

      lastSeenAtByPullRequestId[input.pullRequestId] = input.lastSeenAt;
      return input;
    }
  };
}

export function shouldUseDatabaseRepository(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.PR_TRACKER_USE_DATABASE === "true";
}
