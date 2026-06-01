export type PullRequestState = "open" | "draft" | "closed" | "merged"

export type ReviewDecision = "approved" | "changes_requested" | "commented"

export type WorkflowState =
  | "needs_review"
  | "changed_since_last_seen"
  | "waiting_on_author"
  | "approved"
  | "caught_up"

export interface ReviewerState {
  login: string
  decision: ReviewDecision | "pending"
}

export interface ChangedFile {
  path: string
  additions: number
  deletions: number
}

export interface ReviewThread {
  id: string
  author: string
  status: "resolved" | "unresolved"
  authorReplied: boolean
  excerpt: string
}

export interface ActivityEvent {
  id: string
  actor: string
  action: string
  occurredAt: string
  isNew: boolean
  detail?: string
}

export interface ReviewQueueItem {
  id: string
  repository: string
  number: number
  title: string
  authorLogin: string
  url: string
  state: PullRequestState
  workflowState: WorkflowState
  waitingOn: "you" | "author" | "none"
  waitingAge: string
  updatedAt: string
  openedAt: string
  lastSeenAt: string
  userLastReviewDecision: ReviewDecision
  userLastReviewAt: string
  otherReviewers: ReviewerState[]
  unseenEventCount: number
  newCommitCount: number
  newReplyCount: number
  unresolvedThreadCount: number
  totalThreadCount: number
  changedFilesSinceLastSeen: ChangedFile[]
  reviewThreads: ReviewThread[]
  activityEvents: ActivityEvent[]
  isPinned: boolean
  isMuted: boolean
  snoozedUntil?: string
}

export const reviewItems: ReviewQueueItem[] = [
  {
    id: "pr-4821",
    repository: "core-api",
    number: 4821,
    title: "Add retry + backoff to webhook dispatcher",
    authorLogin: "jordan",
    url: "https://github.com/acme/core-api/pull/4821",
    state: "open",
    workflowState: "needs_review",
    waitingOn: "you",
    waitingAge: "4d",
    updatedAt: "1h ago",
    openedAt: "4 days ago",
    lastSeenAt: "2 days ago",
    userLastReviewDecision: "changes_requested",
    userLastReviewAt: "2 days ago",
    otherReviewers: [
      { login: "sam", decision: "approved" },
      { login: "dana", decision: "pending" },
    ],
    unseenEventCount: 6,
    newCommitCount: 2,
    newReplyCount: 3,
    unresolvedThreadCount: 2,
    totalThreadCount: 5,
    changedFilesSinceLastSeen: [
      { path: "dispatcher.ts", additions: 48, deletions: 10 },
      { path: "retry.test.ts", additions: 22, deletions: 0 },
      { path: "config.ts", additions: 4, deletions: 2 },
    ],
    reviewThreads: [
      {
        id: "thread-1",
        author: "you",
        status: "unresolved",
        authorReplied: true,
        excerpt: "Cap retry attempts so a failed webhook cannot loop forever.",
      },
      {
        id: "thread-2",
        author: "jordan",
        status: "unresolved",
        authorReplied: false,
        excerpt: "Default timeout still needs an answer in config.ts.",
      },
      {
        id: "thread-3",
        author: "sam",
        status: "resolved",
        authorReplied: false,
        excerpt: "Test naming was cleaned up.",
      },
    ],
    activityEvents: [
      {
        id: "event-1",
        actor: "Jordan M.",
        action: "pushed 1 commit",
        occurredAt: "1 hour ago",
        isNew: true,
        detail: "fix: cap retries at 5",
      },
      {
        id: "event-2",
        actor: "Jordan M.",
        action: "resolved 3 threads and re-requested your review",
        occurredAt: "1 hour ago",
        isNew: true,
      },
      {
        id: "event-3",
        actor: "Jordan M.",
        action: "replied to your thread on dispatcher.ts",
        occurredAt: "3 hours ago",
        isNew: true,
        detail: "Good call. I capped this and added a retry-limit test.",
      },
      {
        id: "event-4",
        actor: "Sam P.",
        action: "approved this pull request",
        occurredAt: "5 hours ago",
        isNew: true,
      },
      {
        id: "event-5",
        actor: "You",
        action: "requested changes across 4 files",
        occurredAt: "2 days ago",
        isNew: false,
      },
      {
        id: "event-6",
        actor: "Jordan M.",
        action: "opened this pull request",
        occurredAt: "4 days ago",
        isNew: false,
      },
    ],
    isPinned: true,
    isMuted: false,
  },
  {
    id: "pr-2188",
    repository: "web-app",
    number: 2188,
    title: "Introduce feature-flag SDK wrapper",
    authorLogin: "ravi",
    url: "https://github.com/acme/web-app/pull/2188",
    state: "open",
    workflowState: "changed_since_last_seen",
    waitingOn: "you",
    waitingAge: "5h",
    updatedAt: "1h ago",
    openedAt: "6 days ago",
    lastSeenAt: "2 days ago",
    userLastReviewDecision: "changes_requested",
    userLastReviewAt: "2 days ago",
    otherReviewers: [{ login: "priya", decision: "approved" }],
    unseenEventCount: 5,
    newCommitCount: 1,
    newReplyCount: 2,
    unresolvedThreadCount: 1,
    totalThreadCount: 6,
    changedFilesSinceLastSeen: [
      { path: "flagClient.ts", additions: 36, deletions: 8 },
      { path: "index.ts", additions: 7, deletions: 4 },
    ],
    reviewThreads: [
      {
        id: "thread-4",
        author: "you",
        status: "unresolved",
        authorReplied: true,
        excerpt: "Move the default into the constructor so it cannot drift.",
      },
    ],
    activityEvents: [
      {
        id: "event-7",
        actor: "Ravi S.",
        action: "pushed 1 commit",
        occurredAt: "1 hour ago",
        isNew: true,
        detail: "refactor: extract flag cache",
      },
      {
        id: "event-8",
        actor: "Ravi S.",
        action: "resolved 4 of your 6 threads and re-requested your review",
        occurredAt: "1 hour ago",
        isNew: true,
      },
      {
        id: "event-9",
        actor: "Priya N.",
        action: "approved this pull request",
        occurredAt: "5 hours ago",
        isNew: true,
      },
      {
        id: "event-10",
        actor: "You",
        action: "requested changes across 4 files",
        occurredAt: "2 days ago",
        isNew: false,
      },
    ],
    isPinned: false,
    isMuted: false,
  },
  {
    id: "pr-774",
    repository: "infra",
    number: 774,
    title: "Tighten deployment health polling",
    authorLogin: "mina",
    url: "https://github.com/acme/infra/pull/774",
    state: "open",
    workflowState: "waiting_on_author",
    waitingOn: "author",
    waitingAge: "2d",
    updatedAt: "2d ago",
    openedAt: "5 days ago",
    lastSeenAt: "2 days ago",
    userLastReviewDecision: "changes_requested",
    userLastReviewAt: "2 days ago",
    otherReviewers: [],
    unseenEventCount: 0,
    newCommitCount: 0,
    newReplyCount: 0,
    unresolvedThreadCount: 3,
    totalThreadCount: 4,
    changedFilesSinceLastSeen: [],
    reviewThreads: [],
    activityEvents: [],
    isPinned: false,
    isMuted: false,
  },
]
