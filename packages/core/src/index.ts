export type ReviewDecision = "approved" | "changes_requested" | "commented";

export type PullRequestState = "open" | "closed" | "merged";

export interface Actor {
  id: string;
  login: string;
  avatarUrl?: string;
}

export interface ReviewDecisionEvent {
  id: string;
  reviewerId: string;
  decision: ReviewDecision;
  submittedAt: string;
  commitSha?: string;
  body?: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  participantIds: string[];
  filePath?: string;
  line?: number;
  lastActivityAt: string;
}

export interface PullRequestActivity {
  id: string;
  type:
    | "comment"
    | "commit"
    | "pull_request"
    | "review"
    | "review_request"
    | "thread_resolved"
    | "thread_unresolved"
    | "ready_for_review"
    | "converted_to_draft";
  actorId: string;
  occurredAt: string;
  title: string;
  body?: string;
  url?: string;
  diffUrl?: string;
}

export interface PullRequestItem {
  id: string;
  repository: string;
  number: number;
  title: string;
  description?: string;
  url: string;
  authorId: string;
  state: PullRequestState;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  latestCommitSha: string;
  requestedReviewerIds: string[];
  reviews: ReviewDecisionEvent[];
  threads: ReviewThread[];
  activity: PullRequestActivity[];
}

export interface ViewerContext {
  viewerId: string;
  now: string;
  staleAfterDays: number;
  lastSeenAtByPullRequestId: Record<string, string | undefined>;
}

export const sampleActors: Actor[] = [
  { id: "viewer", login: "you" },
  { id: "maya", login: "maya" },
  { id: "ari", login: "ari" },
  { id: "sam", login: "sam" }
];

export const sampleAvatarUrlsByLogin: Record<string, string> = {
  maya: "https://github.com/identicons/maya.png",
  ari: "https://github.com/identicons/ari.png",
  sam: "https://github.com/identicons/sam.png"
};

export const samplePullRequests: PullRequestItem[] = [
  {
    id: "pr_1",
    repository: "acme/api",
    number: 142,
    title: "Normalize review request webhook payloads",
    url: "https://github.com/acme/api/pull/142",
    authorId: "maya",
    state: "open",
    isDraft: false,
    createdAt: "2026-05-29T08:20:00.000Z",
    updatedAt: "2026-06-01T11:30:00.000Z",
    latestCommitSha: "c2",
    requestedReviewerIds: ["viewer"],
    reviews: [],
    threads: [],
    activity: [
      {
        id: "a1",
        type: "review_request",
        actorId: "maya",
        occurredAt: "2026-06-01T11:30:00.000Z",
        title: "Maya requested your review"
      }
    ]
  },
  {
    id: "pr_2",
    repository: "acme/web",
    number: 87,
    title: "Add persisted reviewer inbox filters",
    url: "https://github.com/acme/web/pull/87",
    authorId: "ari",
    state: "open",
    isDraft: false,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-06-01T09:12:00.000Z",
    latestCommitSha: "f3",
    requestedReviewerIds: [],
    reviews: [
      {
        id: "r1",
        reviewerId: "viewer",
        decision: "approved",
        submittedAt: "2026-05-31T15:15:00.000Z",
        commitSha: "f2"
      }
    ],
    threads: [],
    activity: [
      {
        id: "a2",
        type: "review",
        actorId: "viewer",
        occurredAt: "2026-05-31T15:15:00.000Z",
        title: "You approved this pull request"
      },
      {
        id: "a3",
        type: "commit",
        actorId: "ari",
        occurredAt: "2026-06-01T09:12:00.000Z",
        title: "Ari pushed 1 commit"
      }
    ]
  },
  {
    id: "pr_3",
    repository: "acme/worker",
    number: 35,
    title: "Handle duplicate webhook deliveries",
    url: "https://github.com/acme/worker/pull/35",
    authorId: "sam",
    state: "open",
    isDraft: false,
    createdAt: "2026-05-28T13:45:00.000Z",
    updatedAt: "2026-05-30T10:05:00.000Z",
    latestCommitSha: "d1",
    requestedReviewerIds: [],
    reviews: [
      {
        id: "r2",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-05-30T10:05:00.000Z",
        commitSha: "d1",
        body: "Please make retries idempotent."
      }
    ],
    threads: [
      {
        id: "t1",
        isResolved: false,
        participantIds: ["viewer", "sam"],
        filePath: "src/webhooks.ts",
        line: 44,
        lastActivityAt: "2026-05-30T10:05:00.000Z"
      }
    ],
    activity: [
      {
        id: "a4",
        type: "review",
        actorId: "viewer",
        occurredAt: "2026-05-30T10:05:00.000Z",
        title: "You requested changes"
      }
    ]
  }
];

export const sampleLastSeenAtByPullRequestId: Record<
  string,
  string | undefined
> = {
  pr_1: "2026-06-01T08:00:00.000Z",
  pr_2: "2026-05-31T16:00:00.000Z",
  pr_3: "2026-05-30T11:00:00.000Z"
};
