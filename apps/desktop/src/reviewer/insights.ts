import type { LocalQueueStateByPullRequestId } from "./local-queue-state"
import type { ActivityEventView, ReviewQueueItemView } from "./view-model"

/**
 * Deterministic insight projection over the reviewer inbox.
 *
 * Admission rule: a row earns its place only when it reports an exception,
 * a delta, or a contradiction with the user's own marks — never because a
 * pull request merely exists in the queue. Every trigger below is computed
 * from local facts; each pull request appears in at most one section.
 */

export type InsightKind =
  | "overdue_review"
  | "returned_to_you"
  | "stale_approval"
  | "snoozed_moved_on"
  | "muted_rerequested"
  | "approved_checks_failing"
  | "piling_unseen"
  | "parked_no_movement"
  | "merged_without_you"
  | "closed_without_you"
  | "stalled"
  | "review_ping_pong"

export interface InsightRowView {
  id: string
  kind: InsightKind
  item: ReviewQueueItemView
  /** One short clause naming the trigger, e.g. "your turn for 4d". */
  whyChip: string
}

export interface InsightsDigestView {
  windowStartAt: string
  updatedPullRequestCount: number
  mergedCount: number
  newReviewRequestCount: number
}

export interface ReviewerInsightsView {
  digest?: InsightsDigestView
  needsYouNow: InsightRowView[]
  mightBeMissing: InsightRowView[]
  whileAway: InsightRowView[]
  hygiene: InsightRowView[]
  totalCount: number
}

const dayMs = 24 * 60 * 60 * 1000
const defaultAwayWindowDays = 7
const unseenPileAfterDays = 7
const parkedAfterDays = 7
const stuckReviewRounds = 3

export function buildReviewerInsights(input: {
  items: ReviewQueueItemView[]
  inactiveItems: ReviewQueueItemView[]
  localQueueState: LocalQueueStateByPullRequestId
  previousVisitAt?: string
  now?: number
}): ReviewerInsightsView {
  const now = input.now ?? Date.now()
  const windowStartAt =
    input.previousVisitAt ??
    new Date(now - defaultAwayWindowDays * dayMs).toISOString()
  const windowStart = Date.parse(windowStartAt)
  const claimed = new Set<string>()

  // Sequential so a pull request matching several triggers keeps only its
  // first (highest-priority) row, within and across sections.
  const claim = (rows: InsightRowView[]): InsightRowView[] => {
    const unclaimed: InsightRowView[] = []
    for (const row of rows) {
      if (claimed.has(row.id)) continue
      claimed.add(row.id)
      unclaimed.push(row)
    }
    return unclaimed
  }

  const activeItems = input.items.filter((item) => {
    const local = input.localQueueState[item.id]
    return !local?.snoozed && !local?.muted
  })
  const stashedItems = input.items.filter((item) => {
    const local = input.localQueueState[item.id]
    return Boolean(local?.snoozed || local?.muted)
  })

  const needsYouNow = claim([
    ...collect(activeItems, overdueReview),
    ...collect(activeItems, returnedToYou),
    ...collect(activeItems, staleApproval),
  ])
  const mightBeMissing = claim([
    ...collect(stashedItems, (item) =>
      snoozedMovedOn(item, input.localQueueState)
    ),
    ...collect(stashedItems, (item) =>
      mutedRerequested(item, input.localQueueState)
    ),
    ...collect(activeItems, approvedChecksFailing),
    ...collect(activeItems, (item) => pilingUnseen(item, now)),
    ...collect(activeItems, (item) => parkedNoMovement(item, now)),
  ])
  const whileAway = claim(
    collect(input.inactiveItems, (item) =>
      finishedWithoutYou(item, input.localQueueState, windowStart, now)
    )
  )
  const hygiene = claim([
    ...collect(activeItems, (item) => stalled(item, now)),
    ...collect(activeItems, reviewPingPong),
  ])

  const digest = buildDigest(
    [...input.items, ...input.inactiveItems],
    windowStartAt,
    windowStart
  )

  return {
    digest,
    needsYouNow,
    mightBeMissing,
    whileAway,
    hygiene,
    totalCount:
      needsYouNow.length +
      mightBeMissing.length +
      whileAway.length +
      hygiene.length,
  }
}

function collect(
  items: ReviewQueueItemView[],
  build: (item: ReviewQueueItemView) => InsightRowView | undefined
): InsightRowView[] {
  return items.flatMap((item) => {
    const row = build(item)
    return row ? [row] : []
  })
}

function overdueReview(item: ReviewQueueItemView): InsightRowView | undefined {
  if (item.waitingOn !== "you" || item.waitingUrgency !== "overdue") return

  return {
    id: item.id,
    kind: "overdue_review",
    item,
    whyChip: `Your turn for ${item.waitingAge} — past your overdue threshold`,
  }
}

function returnedToYou(item: ReviewQueueItemView): InsightRowView | undefined {
  if (item.workflowState === "needs_thread_attention") {
    return {
      id: item.id,
      kind: "returned_to_you",
      item,
      whyChip:
        item.unresolvedThreadCount === 1
          ? "1 review thread awaits your reply"
          : `${item.unresolvedThreadCount} review threads await your reply`,
    }
  }

  if (item.workflowState === "updated_since_review") {
    const commits = item.sinceLastReview?.commits.length ?? item.newCommitCount
    return {
      id: item.id,
      kind: "returned_to_you",
      item,
      whyChip:
        commits > 0
          ? `${item.authorLogin} pushed ${formatCountNoun(commits, "commit")} after your review`
          : "Updated since your review",
    }
  }

  return undefined
}

function staleApproval(item: ReviewQueueItemView): InsightRowView | undefined {
  if (!item.approvalStale) return

  const commits = item.sinceLastReview?.commits.length ?? 0
  return {
    id: item.id,
    kind: "stale_approval",
    item,
    whyChip:
      commits > 0
        ? `You approved, then ${formatCountNoun(commits, "commit")} landed`
        : "You approved, then the branch changed",
  }
}

function snoozedMovedOn(
  item: ReviewQueueItemView,
  localQueueState: LocalQueueStateByPullRequestId
): InsightRowView | undefined {
  const local = localQueueState[item.id]
  if (!local?.snoozed || !local.snoozedAt) return

  const snoozedTime = Date.parse(local.snoozedAt)
  const eventsSince = item.activityEvents.filter(
    (event) => Date.parse(event.occurredAtIso) > snoozedTime
  ).length
  if (eventsSince === 0) return

  return {
    id: item.id,
    kind: "snoozed_moved_on",
    item,
    whyChip: `Snoozed, but ${formatCountNoun(eventsSince, "event")} arrived since`,
  }
}

function mutedRerequested(
  item: ReviewQueueItemView,
  localQueueState: LocalQueueStateByPullRequestId
): InsightRowView | undefined {
  const local = localQueueState[item.id]
  if (!local?.muted || !local.mutedAt) return
  if (item.workflowState !== "needs_review") return

  const mutedTime = Date.parse(local.mutedAt)
  const rerequested = item.activityEvents.some(
    (event) =>
      event.type === "review_request" &&
      Date.parse(event.occurredAtIso) > mutedTime
  )
  if (!rerequested) return

  return {
    id: item.id,
    kind: "muted_rerequested",
    item,
    whyChip: "Muted, but your review was requested again",
  }
}

function approvedChecksFailing(
  item: ReviewQueueItemView
): InsightRowView | undefined {
  if (item.userLastReviewDecision !== "approved") return
  if (item.checks?.state !== "failure") return

  return {
    id: item.id,
    kind: "approved_checks_failing",
    item,
    whyChip: "You approved, but checks are failing",
  }
}

function pilingUnseen(
  item: ReviewQueueItemView,
  now: number
): InsightRowView | undefined {
  if (item.unseenEventCount === 0 || !item.lastSeenAtIso) return

  const sinceSeenMs = now - Date.parse(item.lastSeenAtIso)
  if (sinceSeenMs < unseenPileAfterDays * dayMs) return

  return {
    id: item.id,
    kind: "piling_unseen",
    item,
    whyChip: `${formatCountNoun(item.unseenEventCount, "unseen event")} — last opened ${formatDaysAgo(sinceSeenMs)}`,
  }
}

function parkedNoMovement(
  item: ReviewQueueItemView,
  now: number
): InsightRowView | undefined {
  if (item.waitingOn !== "author") return

  const latestActivityAt = item.activityEvents[0]?.occurredAtIso
  if (!latestActivityAt) return

  const idleMs = now - Date.parse(latestActivityAt)
  if (idleMs < parkedAfterDays * dayMs) return

  return {
    id: item.id,
    kind: "parked_no_movement",
    item,
    whyChip: `Author's turn, but nothing moved for ${formatDuration(idleMs)}`,
  }
}

function finishedWithoutYou(
  item: ReviewQueueItemView,
  localQueueState: LocalQueueStateByPullRequestId,
  windowStart: number,
  now: number
): InsightRowView | undefined {
  if (localQueueState[item.id]?.muted) return
  if (item.state !== "merged" && item.state !== "closed") return
  if (Date.parse(item.updatedAtIso) <= windowStart) return
  if (item.userLastReviewDecision === "approved") return

  const agoMs = now - Date.parse(item.updatedAtIso)
  return {
    id: item.id,
    kind: item.state === "merged" ? "merged_without_you" : "closed_without_you",
    item,
    whyChip:
      item.state === "merged"
        ? `Merged ${formatDaysAgo(agoMs)} without your review`
        : `Closed ${formatDaysAgo(agoMs)} — safe to drop`,
  }
}

function stalled(
  item: ReviewQueueItemView,
  now: number
): InsightRowView | undefined {
  if (item.workflowState !== "stale") return

  const quietFor = formatDuration(now - Date.parse(item.updatedAtIso))
  const lastEvent = item.activityEvents[0]
  return {
    id: item.id,
    kind: "stalled",
    item,
    whyChip: lastEvent
      ? `No activity for ${quietFor} — last was ${eventNoun(lastEvent.type)}`
      : `No activity for ${quietFor}`,
  }
}

function eventNoun(type: ActivityEventView["type"]): string {
  switch (type) {
    case "comment":
      return "a comment"
    case "commit":
      return "a commit"
    case "review":
      return "a review"
    case "review_request":
      return "a review request"
    case "thread_resolved":
      return "a thread being resolved"
    case "thread_unresolved":
      return "a thread reopening"
    case "ready_for_review":
      return "it leaving draft"
    case "converted_to_draft":
      return "it becoming a draft"
    default:
      return "the pull request opening"
  }
}

function reviewPingPong(item: ReviewQueueItemView): InsightRowView | undefined {
  if (item.reviewRounds < stuckReviewRounds) return

  return {
    id: item.id,
    kind: "review_ping_pong",
    item,
    whyChip: `${item.reviewRounds} changes-requested rounds — consider a direct chat`,
  }
}

function buildDigest(
  allItems: ReviewQueueItemView[],
  windowStartAt: string,
  windowStart: number
): InsightsDigestView | undefined {
  let updatedPullRequestCount = 0
  let mergedCount = 0
  let newReviewRequestCount = 0

  for (const item of allItems) {
    const updatedInWindow = Date.parse(item.updatedAtIso) > windowStart
    if (updatedInWindow) updatedPullRequestCount += 1
    if (updatedInWindow && item.state === "merged") mergedCount += 1
    if (
      item.workflowState === "needs_review" &&
      item.activityEvents.some(
        (event) =>
          event.type === "review_request" &&
          Date.parse(event.occurredAtIso) > windowStart
      )
    ) {
      newReviewRequestCount += 1
    }
  }

  if (
    updatedPullRequestCount === 0 &&
    mergedCount === 0 &&
    newReviewRequestCount === 0
  ) {
    return undefined
  }

  return {
    windowStartAt,
    updatedPullRequestCount,
    mergedCount,
    newReviewRequestCount,
  }
}

function formatCountNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function formatDaysAgo(elapsedMs: number): string {
  const duration = formatDuration(elapsedMs)
  return duration === "today" ? "today" : `${duration} ago`
}

function formatDuration(elapsedMs: number): string {
  const hours = Math.floor(Math.max(0, elapsedMs) / (60 * 60 * 1000))
  if (hours < 1) return "today"
  if (hours < 48) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`

  // Week granularity up to two months so a 44-day wait reads as "6w"
  // instead of rounding all the way down to "1mo".
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks}w`

  return `${Math.floor(days / 30)}mo`
}
