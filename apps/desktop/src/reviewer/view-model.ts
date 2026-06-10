import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecision,
  ReviewDecisionEvent,
} from "@pr-tracker/core"
import type {
  ClassificationEvidence,
  ClassifiedPullRequest,
  ReviewerInbox,
  TurnState,
  WorkflowState,
} from "@pr-tracker/reviewer-workflow"

export type ReviewLaneId =
  | "needs_review"
  | "updated_since_review"
  | "waiting_on_author"

export type ReviewQueueBucketId = ReviewLaneId | "approved" | "watching"

export type WaitingOn = "you" | "author" | "none"

export type WaitingUrgency = "none" | "elevated" | "overdue"

export interface SinceLastReviewView {
  decision: ReviewDecision
  reviewedAt: string
  /** Commit activity observed after the review; may be empty when commit
   * events were not ingested even though the head moved. */
  commits: Array<{ id: string; title: string; occurredAt: string }>
  replyCount: number
  threadsResolvedCount: number
  compareUrl?: string
}

export interface EvidenceLineView {
  id: string
  label: string
  occurredAt?: string
  actorLogin?: string
}

export interface ReviewerState {
  login: string
  avatarUrl?: string
  decision: ReviewDecision | "pending"
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
  actorAvatarUrl?: string
  action: string
  occurredAt: string
  occurredAtIso: string
  isNew: boolean
  detail?: string
  url?: string
  diffUrl?: string
}

export interface ReviewQueueItemView {
  id: string
  repository: string
  number: number
  title: string
  description?: string
  authorLogin: string
  authorAvatarUrl?: string
  url: string
  workflowState: WorkflowState
  laneId: ReviewLaneId | "approved" | "caught_up" | "watching" | "stale"
  reason: string
  evidence: EvidenceLineView[]
  waitingOn: WaitingOn
  waitingAge: string
  waitingUrgency: WaitingUrgency
  updatedAt: string
  openedAt: string
  lastSeenAt: string
  userLastReviewDecision: ReviewDecision | "pending"
  userLastReviewAt?: string
  sinceLastReview?: SinceLastReviewView
  approvalStale: boolean
  /** Completed changes-requested → push cycles; high counts mean stuck. */
  reviewRounds: number
  otherReviewers: ReviewerState[]
  unseenEventCount: number
  newCommitCount: number
  newReplyCount: number
  unresolvedThreadCount: number
  totalThreadCount: number
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

export function canMarkReviewItemCaughtUp(
  item: Pick<ReviewQueueItemView, "unseenEventCount"> | undefined,
  isSaving: boolean
): boolean {
  return Boolean(item && item.unseenEventCount > 0 && !isSaving)
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
  const authorAvatarUrl = actorById.get(pullRequest.authorId)?.avatarUrl
  const waitingOn = getWaitingOn(item.turn)
  const lastMeaningfulAt =
    latestNewActivity?.occurredAt ??
    latestViewerReview?.submittedAt ??
    pullRequest.updatedAt
  const waitingSinceAt = item.turn.since ?? lastMeaningfulAt
  const reviewedHeadMoved = Boolean(
    latestViewerReview?.commitSha &&
      latestViewerReview.commitSha !== pullRequest.latestCommitSha
  )

  return {
    id: pullRequest.id,
    repository: pullRequest.repository,
    number: pullRequest.number,
    title: pullRequest.title,
    description: pullRequest.description,
    authorLogin,
    authorAvatarUrl,
    url: pullRequest.url,
    workflowState: item.workflowState,
    laneId: getLaneId(item.workflowState),
    reason: item.reason,
    evidence: item.evidence.map((entry) =>
      toEvidenceLineView(entry, actorById)
    ),
    waitingOn,
    waitingAge: formatDurationSince(waitingSinceAt),
    waitingUrgency: getWaitingUrgency(waitingOn, waitingSinceAt),
    updatedAt: formatRelativeTime(pullRequest.updatedAt),
    openedAt: formatRelativeTime(pullRequest.createdAt),
    lastSeenAt: lastSeenAt ? formatRelativeTime(lastSeenAt) : "not seen yet",
    userLastReviewDecision: latestViewerReview?.decision ?? "pending",
    userLastReviewAt: latestViewerReview
      ? formatRelativeTime(latestViewerReview.submittedAt)
      : undefined,
    sinceLastReview: latestViewerReview
      ? buildSinceLastReview(pullRequest, latestViewerReview, reviewedHeadMoved)
      : undefined,
    approvalStale:
      latestViewerReview?.decision === "approved" && reviewedHeadMoved,
    reviewRounds: countReviewRounds(viewerReviews, pullRequest.activity),
    otherReviewers: buildReviewerStates(pullRequest, actorById, viewerId),
    unseenEventCount: item.unseenActivityCount,
    newCommitCount: newActivity.filter((event) => event.type === "commit").length,
    newReplyCount: newActivity.filter((event) =>
      ["comment", "review"].includes(event.type)
    ).length,
    unresolvedThreadCount: pullRequest.threads.filter((thread) => !thread.isResolved)
      .length,
    totalThreadCount: pullRequest.threads.length,
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

function getWaitingOn(turn: TurnState): WaitingOn {
  if (turn.owner === "viewer") return "you"
  if (turn.owner === "author") return "author"
  return "none"
}

const elevatedWaitMs = 24 * 60 * 60 * 1000
const overdueWaitMs = 72 * 60 * 60 * 1000

function getWaitingUrgency(
  waitingOn: WaitingOn,
  waitingSinceAt: string | undefined
): WaitingUrgency {
  if (waitingOn === "none" || !waitingSinceAt) return "none"

  const since = Date.parse(waitingSinceAt)
  if (Number.isNaN(since)) return "none"

  const waitedMs = Date.now() - since
  if (waitedMs >= overdueWaitMs) return "overdue"
  if (waitedMs >= elevatedWaitMs) return "elevated"
  return "none"
}

function countReviewRounds(
  viewerReviews: ReviewDecisionEvent[],
  activity: PullRequestActivity[]
): number {
  const commitTimes = activity
    .filter((event) => event.type === "commit")
    .map((event) => Date.parse(event.occurredAt))

  return viewerReviews.filter(
    (review) =>
      review.decision === "changes_requested" &&
      commitTimes.some((time) => time > Date.parse(review.submittedAt))
  ).length
}

function buildSinceLastReview(
  pullRequest: PullRequestItem,
  review: ReviewDecisionEvent,
  reviewedHeadMoved: boolean
): SinceLastReviewView | undefined {
  const reviewTime = Date.parse(review.submittedAt)
  const activitySinceReview = pullRequest.activity.filter(
    (event) => Date.parse(event.occurredAt) > reviewTime
  )
  const commits = activitySinceReview
    .filter((event) => event.type === "commit")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .map((event) => ({
      id: event.id,
      title: event.title,
      occurredAt: formatRelativeTime(event.occurredAt),
    }))
  const replyCount = activitySinceReview.filter(
    (event) =>
      ["comment", "review"].includes(event.type) &&
      event.actorId !== review.reviewerId
  ).length
  const threadsResolvedCount = activitySinceReview.filter(
    (event) => event.type === "thread_resolved"
  ).length

  if (
    !reviewedHeadMoved &&
    commits.length === 0 &&
    replyCount === 0 &&
    threadsResolvedCount === 0
  ) {
    return undefined
  }

  return {
    decision: review.decision,
    reviewedAt: formatRelativeTime(review.submittedAt),
    commits,
    replyCount,
    threadsResolvedCount,
    compareUrl:
      reviewedHeadMoved && review.commitSha
        ? buildCompareUrl(
            pullRequest.url,
            review.commitSha,
            pullRequest.latestCommitSha
          )
        : undefined,
  }
}

function buildCompareUrl(
  pullRequestUrl: string,
  fromSha: string,
  toSha: string
): string | undefined {
  const repositoryUrl = pullRequestUrl.replace(/\/pull\/\d+.*$/, "")
  if (repositoryUrl === pullRequestUrl) return undefined
  return `${repositoryUrl}/compare/${fromSha}..${toSha}`
}

function toEvidenceLineView(
  entry: ClassificationEvidence,
  actorById: Map<string, Actor>
): EvidenceLineView {
  return {
    id: entry.id,
    label: entry.label,
    occurredAt: entry.occurredAt
      ? formatRelativeTime(entry.occurredAt)
      : undefined,
    actorLogin: entry.actorId
      ? actorLogin(actorById, entry.actorId)
      : undefined,
  }
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
    avatarUrl: actorById.get(reviewerId)?.avatarUrl,
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
    actorAvatarUrl: actorById.get(event.actorId)?.avatarUrl,
    action: withoutActorPrefix(event.title, actor),
    occurredAt: formatRelativeTime(event.occurredAt),
    occurredAtIso: event.occurredAt,
    isNew: isNewerThan(event.occurredAt, lastSeenAt),
    detail: event.body,
    url: event.url,
    diffUrl: event.diffUrl,
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
