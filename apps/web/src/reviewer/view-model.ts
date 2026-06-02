import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecision,
} from "@pr-tracker/core"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
  WorkflowState,
} from "@pr-tracker/reviewer-workflow"

export type ReviewLaneId =
  | "needs_review"
  | "updated_since_review"
  | "waiting_on_author"

export type ReviewQueueBucketId = ReviewLaneId | "approved" | "watching"

export type WaitingOn = "you" | "author" | "none"

export interface ReviewerState {
  login: string
  decision: ReviewDecision | "pending"
}

export interface ChangedFile {
  path: string
  additions?: number
  deletions?: number
}

export interface ReviewThreadView {
  id: string
  author: string
  status: "resolved" | "unresolved"
  authorReplied: boolean
  excerpt: string
}

export interface ActivityEventView {
  id: string
  actor: string
  action: string
  occurredAt: string
  occurredAtIso: string
  isNew: boolean
  detail?: string
}

export interface ReviewQueueItemView {
  id: string
  repository: string
  number: number
  title: string
  authorLogin: string
  url: string
  workflowState: WorkflowState
  laneId: ReviewLaneId | "approved" | "caught_up" | "watching" | "stale"
  reason: string
  waitingOn: WaitingOn
  waitingAge: string
  updatedAt: string
  openedAt: string
  lastSeenAt: string
  userLastReviewDecision: ReviewDecision | "pending"
  userLastReviewAt?: string
  otherReviewers: ReviewerState[]
  unseenEventCount: number
  newCommitCount: number
  newReplyCount: number
  unresolvedThreadCount: number
  totalThreadCount: number
  changedFilesSinceLastSeen: ChangedFile[]
  reviewThreads: ReviewThreadView[]
  activityEvents: ActivityEventView[]
  isPinned: boolean
  isMuted: boolean
  snoozedUntil?: string
}

export interface ReviewerInboxView {
  items: ReviewQueueItemView[]
  laneItems: Record<ReviewQueueBucketId, ReviewQueueItemView[]>
  approvedCount: number
  watchingCount: number
  actorById: Map<string, Actor>
  viewerId: string
}

export function buildInboxView(inbox: ReviewerInbox): ReviewerInboxView {
  const actorById = new Map(inbox.actors.map((actor) => [actor.id, actor]))
  const items = inbox.items.map((item) =>
    toReviewQueueItemView(item, actorById, inbox.viewer.id)
  )

  return {
    items,
    laneItems: {
      needs_review: items.filter((item) => item.laneId === "needs_review"),
      updated_since_review: items.filter(
        (item) => item.laneId === "updated_since_review"
      ),
      waiting_on_author: items.filter(
        (item) => item.laneId === "waiting_on_author"
      ),
      approved: items.filter((item) => item.laneId === "approved"),
      watching: items.filter(
        (item) =>
          item.laneId === "caught_up" ||
          item.laneId === "watching" ||
          item.laneId === "stale"
      ),
    },
    approvedCount: items.filter((item) => item.laneId === "approved").length,
    watchingCount: items.filter(
      (item) =>
        item.laneId === "caught_up" ||
        item.laneId === "watching" ||
        item.laneId === "stale"
    ).length,
    actorById,
    viewerId: inbox.viewer.id,
  }
}

export function toReviewQueueItemView(
  item: ClassifiedPullRequest,
  actorById: Map<string, Actor>,
  viewerId: string
): ReviewQueueItemView {
  const pullRequest = item.pullRequest
  const lastSeenAt = item.lastSeenAt
  const newActivity = pullRequest.activity.filter((event) =>
    isNewerThan(event.occurredAt, lastSeenAt)
  )
  const latestNewActivity = maxByIsoDate(newActivity, (event) => event.occurredAt)
  const viewerReviews = pullRequest.reviews
    .filter((review) => review.reviewerId === viewerId)
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
  const latestViewerReview = viewerReviews[0]
  const authorLogin = actorLogin(actorById, pullRequest.authorId)
  const waitingOn = getWaitingOn(item.workflowState)
  const lastMeaningfulAt =
    latestNewActivity?.occurredAt ??
    latestViewerReview?.submittedAt ??
    pullRequest.updatedAt

  return {
    id: pullRequest.id,
    repository: pullRequest.repository,
    number: pullRequest.number,
    title: pullRequest.title,
    authorLogin,
    url: pullRequest.url,
    workflowState: item.workflowState,
    laneId: getLaneId(item.workflowState),
    reason: item.reason,
    waitingOn,
    waitingAge: formatDurationSince(lastMeaningfulAt),
    updatedAt: formatRelativeTime(pullRequest.updatedAt),
    openedAt: formatRelativeTime(pullRequest.createdAt),
    lastSeenAt: lastSeenAt ? formatRelativeTime(lastSeenAt) : "not seen yet",
    userLastReviewDecision: latestViewerReview?.decision ?? "pending",
    userLastReviewAt: latestViewerReview
      ? formatRelativeTime(latestViewerReview.submittedAt)
      : undefined,
    otherReviewers: buildReviewerStates(pullRequest, actorById, viewerId),
    unseenEventCount: item.unseenActivityCount,
    newCommitCount: newActivity.filter((event) => event.type === "commit").length,
    newReplyCount: newActivity.filter((event) =>
      ["comment", "review"].includes(event.type)
    ).length,
    unresolvedThreadCount: pullRequest.threads.filter((thread) => !thread.isResolved)
      .length,
    totalThreadCount: pullRequest.threads.length,
    changedFilesSinceLastSeen: [],
    reviewThreads: pullRequest.threads.map((thread) => ({
      id: thread.id,
      author: thread.participantIds
        .map((participantId) => actorLogin(actorById, participantId))
        .find((login) => login !== "you") ?? authorLogin,
      status: thread.isResolved ? "resolved" : "unresolved",
      authorReplied: isNewerThan(thread.lastActivityAt, lastSeenAt),
      excerpt: thread.filePath
        ? `${thread.filePath}${thread.line ? `:${thread.line}` : ""}`
        : "Review thread",
    })),
    activityEvents: pullRequest.activity
      .slice()
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .map((event) => toActivityEventView(event, actorById, lastSeenAt)),
    isPinned: false,
    isMuted: item.workflowState === "watching",
  }
}

export function actorLogin(
  actorById: Map<string, Actor>,
  actorId: string | undefined
): string {
  if (!actorId) return "unknown"
  return actorById.get(actorId)?.login ?? actorId
}

export function formatRelativeTime(isoDate: string | undefined): string {
  if (!isoDate) return "unknown"
  const duration = formatDurationSince(isoDate)
  return duration === "now" ? "just now" : `${duration} ago`
}

export function formatDurationSince(isoDate: string | undefined): string {
  if (!isoDate) return "unknown"
  const time = Date.parse(isoDate)
  if (Number.isNaN(time)) return "unknown"

  const elapsedMs = Math.max(0, Date.now() - time)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`

  return `${Math.floor(months / 12)}y`
}

function getLaneId(
  workflowState: WorkflowState
): ReviewQueueItemView["laneId"] {
  if (workflowState === "needs_review") return "needs_review"
  if (workflowState === "waiting_on_author") return "waiting_on_author"
  if (
    workflowState === "updated_since_review" ||
    workflowState === "needs_thread_attention"
  ) {
    return "updated_since_review"
  }
  if (workflowState === "approved") return "approved"
  if (workflowState === "caught_up") return "caught_up"
  if (workflowState === "stale") return "stale"
  return "watching"
}

function getWaitingOn(workflowState: WorkflowState): WaitingOn {
  if (
    workflowState === "needs_review" ||
    workflowState === "updated_since_review" ||
    workflowState === "needs_thread_attention"
  ) {
    return "you"
  }
  if (workflowState === "waiting_on_author") return "author"
  return "none"
}

function buildReviewerStates(
  pullRequest: PullRequestItem,
  actorById: Map<string, Actor>,
  viewerId: string
): ReviewerState[] {
  const latestByReviewer = new Map<string, ReviewDecision | "pending">()

  const reviewsNewestFirst = pullRequest.reviews
    .slice()
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))

  for (const review of reviewsNewestFirst) {
    if (review.reviewerId === viewerId) continue
    if (latestByReviewer.has(review.reviewerId)) continue
    latestByReviewer.set(review.reviewerId, review.decision)
  }

  for (const reviewerId of pullRequest.requestedReviewerIds) {
    if (reviewerId === viewerId || latestByReviewer.has(reviewerId)) continue
    latestByReviewer.set(reviewerId, "pending")
  }

  return [...latestByReviewer].map(([reviewerId, decision]) => ({
    login: actorLogin(actorById, reviewerId),
    decision,
  }))
}

function toActivityEventView(
  event: PullRequestActivity,
  actorById: Map<string, Actor>,
  lastSeenAt: string | undefined
): ActivityEventView {
  const actor = actorLogin(actorById, event.actorId)

  return {
    id: event.id,
    actor,
    action: withoutActorPrefix(event.title, actor),
    occurredAt: formatRelativeTime(event.occurredAt),
    occurredAtIso: event.occurredAt,
    isNew: isNewerThan(event.occurredAt, lastSeenAt),
    detail: event.body,
  }
}

function withoutActorPrefix(title: string, actor: string): string {
  const normalizedActor = actor.toLowerCase()
  const normalizedTitle = title.toLowerCase()

  if (normalizedTitle === normalizedActor) return title
  if (normalizedTitle.startsWith(`${normalizedActor} `)) {
    return title.slice(actor.length + 1)
  }

  return title
}

function isNewerThan(
  isoDate: string | undefined,
  comparisonIsoDate: string | undefined
): boolean {
  if (!isoDate || !comparisonIsoDate) return Boolean(isoDate)
  return Date.parse(isoDate) > Date.parse(comparisonIsoDate)
}

function maxByIsoDate<T>(
  items: T[],
  getIsoDate: (item: T) => string | undefined
): T | undefined {
  return items.reduce<T | undefined>((latest, item) => {
    const itemTime = Date.parse(getIsoDate(item) ?? "")
    if (Number.isNaN(itemTime)) return latest

    const latestTime = latest ? Date.parse(getIsoDate(latest) ?? "") : NaN
    return !latest || Number.isNaN(latestTime) || itemTime > latestTime
      ? item
      : latest
  }, undefined)
}
