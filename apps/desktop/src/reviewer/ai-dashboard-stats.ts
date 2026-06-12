import type { LocalQueueStateByPullRequestId } from "./local-queue-state"
import type { AttentionThresholds, ReviewQueueItemView } from "./view-model"

export interface AiDashboardKpis {
  needsReview: {
    count: number
    overdueCount: number
  }
  unseenActivity: {
    count: number
    eventCount: number
  }
  staleApprovals: {
    count: number
    oldestDays?: number
  }
  oldestWait: {
    hours?: number
    label: string
    item?: ReviewQueueItemView
    isOverdue: boolean
  }
  failingChecks: {
    count: number
    waitingOnYouCount: number
  }
  concludedWhileAway: {
    count: number
    withoutYourReviewCount: number
  }
}

export interface AiDashboardBucket {
  id: string
  label: string
  count: number
  tone?: "default" | "overdue" | "muted"
}

export interface AiDashboardTrendDay {
  dateKey: string
  label: string
  eventCount: number
  pullRequestCount: number
  isVisitDay: boolean
}

export interface AiDashboardRepositoryRow {
  repository: string
  itemCount: number
  waitingOnYouCount: number
  oldestWaitLabel: string
  oldestWaitHours?: number
}

export interface AiDashboardHotspotRow {
  item: ReviewQueueItemView
  unresolvedThreadCount: number
  lastReplyLogin: string
  lastReplyAtIso?: string
}

export interface AiDashboardAuthorRow {
  login: string
  avatarUrl?: string
  count: number
  oldestWaitLabel: string
  oldestWaitHours?: number
}

export interface AiDashboardStats {
  itemCount: number
  activeItemCount: number
  kpis: AiDashboardKpis
  waitAgeDistribution: AiDashboardBucket[]
  laneComposition: AiDashboardBucket[]
  activityTrend: AiDashboardTrendDay[]
  repositoryBreakdown: {
    rows: AiDashboardRepositoryRow[]
    remainingCount: number
    isHidden: boolean
  }
  discussionHotspots: AiDashboardHotspotRow[]
  authorsWaiting: {
    rows: AiDashboardAuthorRow[]
    isHidden: boolean
  }
}

const dayMs = 24 * 60 * 60 * 1000
const hourMs = 60 * 60 * 1000
const trendDays = 14

export function buildAiDashboardStats(input: {
  items: ReviewQueueItemView[]
  thresholds: AttentionThresholds
  localQueueState?: LocalQueueStateByPullRequestId
  previousVisitAt?: string
  now?: number
}): AiDashboardStats {
  const now = input.now ?? Date.now()
  const activeItems = input.items.filter((item) => item.state === "open")
  const waitingOnYouItems = activeItems.filter((item) => item.waitingOn === "you")
  const failingCheckItems = activeItems.filter(
    (item) => item.checks?.state === "failure"
  )
  const staleApprovalItems = activeItems.filter((item) => item.approvalStale)
  const concludedItems = input.items.filter((item) =>
    isConcludedSince(item, input.previousVisitAt)
  )
  const oldestWaitingItem = maxBy(waitingOnYouItems, (item) =>
    waitingHours(item, now)
  )
  const oldestWaitHours = oldestWaitingItem
    ? waitingHours(oldestWaitingItem, now)
    : undefined

  return {
    itemCount: input.items.length,
    activeItemCount: activeItems.length,
    kpis: {
      needsReview: {
        count: waitingOnYouItems.length,
        overdueCount: waitingOnYouItems.filter(
          (item) => item.waitingUrgency === "overdue"
        ).length,
      },
      unseenActivity: {
        count: activeItems.filter((item) => item.unseenEventCount > 0).length,
        eventCount: activeItems.reduce(
          (total, item) => total + item.unseenEventCount,
          0
        ),
      },
      staleApprovals: {
        count: staleApprovalItems.length,
        oldestDays: oldestStaleApprovalDays(staleApprovalItems, now),
      },
      oldestWait: {
        hours: oldestWaitHours,
        label: oldestWaitingItem ? oldestWaitingItem.waitingAge : "None",
        item: oldestWaitingItem,
        isOverdue:
          oldestWaitHours !== undefined &&
          oldestWaitHours >= input.thresholds.overdueAfterHours,
      },
      failingChecks: {
        count: failingCheckItems.length,
        waitingOnYouCount: failingCheckItems.filter(
          (item) => item.waitingOn === "you"
        ).length,
      },
      concludedWhileAway: {
        count: concludedItems.length,
        withoutYourReviewCount: concludedItems.filter(
          (item) => item.userLastReviewDecision !== "approved"
        ).length,
      },
    },
    waitAgeDistribution: buildWaitAgeDistribution(
      waitingOnYouItems,
      input.thresholds,
      now
    ),
    laneComposition: buildLaneComposition(input.items, input.localQueueState),
    activityTrend: buildActivityTrend(input.items, input.previousVisitAt, now),
    repositoryBreakdown: buildRepositoryBreakdown(activeItems, now),
    discussionHotspots: buildDiscussionHotspots(activeItems),
    authorsWaiting: buildAuthorsWaiting(waitingOnYouItems, now),
  }
}

function buildWaitAgeDistribution(
  items: ReviewQueueItemView[],
  thresholds: AttentionThresholds,
  now: number
): AiDashboardBucket[] {
  const thresholdLabel = formatHours(thresholds.overdueAfterHours)
  const buckets: AiDashboardBucket[] = [
    { id: "lt_1d", label: "<1d", count: 0 },
    { id: "one_to_three_days", label: "1-3d", count: 0 },
    { id: "three_days_to_threshold", label: `3d-${thresholdLabel}`, count: 0 },
    {
      id: "past_threshold",
      label: `past ${thresholdLabel}`,
      count: 0,
      tone: "overdue",
    },
  ]

  for (const item of items) {
    const hours = waitingHours(item, now)
    if (hours < 24) {
      buckets[0]!.count += 1
    } else if (hours < 72) {
      buckets[1]!.count += 1
    } else if (hours < thresholds.overdueAfterHours) {
      buckets[2]!.count += 1
    } else {
      buckets[3]!.count += 1
    }
  }

  return buckets
}

function buildLaneComposition(
  items: ReviewQueueItemView[],
  localQueueState: LocalQueueStateByPullRequestId | undefined
): AiDashboardBucket[] {
  const counts = new Map<string, AiDashboardBucket>()

  for (const item of items) {
    const local = localQueueState?.[item.id]
    const bucket =
      item.state === "merged" || item.state === "closed"
        ? ({ id: "concluded", label: "Concluded", tone: "muted" } as const)
        : local?.snoozed
          ? ({ id: "snoozed", label: "Snoozed", tone: "muted" } as const)
          : local?.muted
            ? ({ id: "muted", label: "Muted", tone: "muted" } as const)
            : laneBucket(item.laneId)
    const existing = counts.get(bucket.id)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(bucket.id, { ...bucket, count: 1 })
    }
  }

  return [...counts.values()].sort((a, b) => {
    const aIndex = laneOrder.indexOf(a.id)
    const bIndex = laneOrder.indexOf(b.id)
    return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex)
  })
}

function laneBucket(laneId: ReviewQueueItemView["laneId"]): {
  id: string
  label: string
  tone?: "default" | "overdue" | "muted"
} {
  switch (laneId) {
    case "needs_review":
      return { id: laneId, label: "Needs review" }
    case "updated_since_review":
      return { id: laneId, label: "Updated" }
    case "waiting_on_author":
      return { id: laneId, label: "Waiting on author" }
    case "approved":
      return { id: laneId, label: "Approved" }
    case "caught_up":
      return { id: laneId, label: "Caught up" }
    case "stale":
      return { id: laneId, label: "Stale" }
    default:
      return { id: "watching", label: "Watching" }
  }
}

const laneOrder = [
  "needs_review",
  "updated_since_review",
  "waiting_on_author",
  "approved",
  "caught_up",
  "stale",
  "watching",
  "snoozed",
  "muted",
  "concluded",
]

function buildActivityTrend(
  items: ReviewQueueItemView[],
  previousVisitAt: string | undefined,
  now: number
): AiDashboardTrendDay[] {
  const todayStart = startOfLocalDay(now)
  const start = todayStart - (trendDays - 1) * dayMs
  const days = Array.from({ length: trendDays }, (_, index) => {
    const time = start + index * dayMs
    return {
      dateKey: dateKey(time),
      label: formatShortDate(time),
      eventCount: 0,
      pullRequestIds: new Set<string>(),
      isVisitDay: previousVisitAt
        ? dateKey(Date.parse(previousVisitAt)) === dateKey(time)
        : false,
    }
  })
  const dayByKey = new Map(days.map((day) => [day.dateKey, day]))

  for (const item of items) {
    for (const event of item.activityEvents) {
      const eventTime = Date.parse(event.occurredAtIso)
      if (Number.isNaN(eventTime) || eventTime < start || eventTime > now) {
        continue
      }
      const day = dayByKey.get(dateKey(eventTime))
      if (!day) continue
      day.eventCount += 1
      day.pullRequestIds.add(item.id)
    }
  }

  return days.map((day) => ({
    dateKey: day.dateKey,
    label: day.label,
    eventCount: day.eventCount,
    pullRequestCount: day.pullRequestIds.size,
    isVisitDay: day.isVisitDay,
  }))
}

function buildRepositoryBreakdown(
  items: ReviewQueueItemView[],
  now: number
): AiDashboardStats["repositoryBreakdown"] {
  const rowsByRepository = new Map<string, AiDashboardRepositoryRow>()

  for (const item of items) {
    const row = rowsByRepository.get(item.repository) ?? {
      repository: item.repository,
      itemCount: 0,
      waitingOnYouCount: 0,
      oldestWaitLabel: "None",
    }
    row.itemCount += 1
    if (item.waitingOn === "you") {
      row.waitingOnYouCount += 1
      const hours = waitingHours(item, now)
      if (row.oldestWaitHours === undefined || hours > row.oldestWaitHours) {
        row.oldestWaitHours = hours
        row.oldestWaitLabel = item.waitingAge
      }
    }
    rowsByRepository.set(item.repository, row)
  }

  const rows = [...rowsByRepository.values()].sort(
    (a, b) =>
      b.waitingOnYouCount - a.waitingOnYouCount ||
      b.itemCount - a.itemCount ||
      a.repository.localeCompare(b.repository)
  )

  return {
    rows: rows.slice(0, 6),
    remainingCount: Math.max(0, rows.length - 6),
    isHidden: rows.length <= 1,
  }
}

function buildDiscussionHotspots(
  items: ReviewQueueItemView[]
): AiDashboardHotspotRow[] {
  return items
    .filter((item) => item.unresolvedThreadCount > 0)
    .sort(
      (a, b) =>
        b.unresolvedThreadCount - a.unresolvedThreadCount ||
        newestUnresolvedThreadTime(b) - newestUnresolvedThreadTime(a)
    )
    .slice(0, 5)
    .map((item) => {
      const thread = item.reviewThreads
        .filter((entry) => entry.status === "unresolved")
        .sort(
          (a, b) =>
            Date.parse(b.lastActivityAtIso ?? "") -
            Date.parse(a.lastActivityAtIso ?? "")
        )[0]
      return {
        item,
        unresolvedThreadCount: item.unresolvedThreadCount,
        lastReplyLogin: thread?.lastActorLogin ?? thread?.author ?? "unknown",
        lastReplyAtIso: thread?.lastActivityAtIso,
      }
    })
}

function buildAuthorsWaiting(
  items: ReviewQueueItemView[],
  now: number
): AiDashboardStats["authorsWaiting"] {
  const rowsByAuthor = new Map<string, AiDashboardAuthorRow>()

  for (const item of items) {
    const row = rowsByAuthor.get(item.authorLogin) ?? {
      login: item.authorLogin,
      avatarUrl: item.authorAvatarUrl,
      count: 0,
      oldestWaitLabel: item.waitingAge,
      oldestWaitHours: waitingHours(item, now),
    }
    row.count += 1
    const hours = waitingHours(item, now)
    if (row.oldestWaitHours === undefined || hours > row.oldestWaitHours) {
      row.oldestWaitHours = hours
      row.oldestWaitLabel = item.waitingAge
    }
    rowsByAuthor.set(item.authorLogin, row)
  }

  const rows = [...rowsByAuthor.values()].sort(
    (a, b) =>
      (b.oldestWaitHours ?? 0) - (a.oldestWaitHours ?? 0) ||
      b.count - a.count ||
      a.login.localeCompare(b.login)
  )

  return {
    rows: rows.slice(0, 5),
    isHidden: rows.length < 2,
  }
}

function isConcludedSince(
  item: ReviewQueueItemView,
  previousVisitAt: string | undefined
): boolean {
  if (item.state !== "merged" && item.state !== "closed") return false
  if (!previousVisitAt) return true
  return Date.parse(item.updatedAtIso) > Date.parse(previousVisitAt)
}

function oldestStaleApprovalDays(
  items: ReviewQueueItemView[],
  now: number
): number | undefined {
  const oldestHours = maxBy(items, (item) => staleApprovalHours(item, now))
  if (!oldestHours) return undefined

  const hours = staleApprovalHours(oldestHours, now)
  return hours === undefined ? undefined : Math.max(0, Math.floor(hours / 24))
}

function staleApprovalHours(
  item: ReviewQueueItemView,
  now: number
): number | undefined {
  const reviewTime = Date.parse(item.userLastReviewAtIso ?? "")
  const commitTimes = item.activityEvents
    .filter((event) => event.type === "commit")
    .map((event) => Date.parse(event.occurredAtIso))
    .filter((time) => !Number.isNaN(time) && time > reviewTime)
  const staleSince = commitTimes.length > 0 ? Math.min(...commitTimes) : Date.parse(item.updatedAtIso)
  if (Number.isNaN(staleSince)) return undefined
  return Math.max(0, (now - staleSince) / hourMs)
}

function waitingHours(item: ReviewQueueItemView, now: number): number {
  const waitingSince = Date.parse(item.waitingSinceAtIso ?? "")
  if (!Number.isNaN(waitingSince)) {
    return Math.max(0, (now - waitingSince) / hourMs)
  }

  return parseDurationHours(item.waitingAge)
}

function parseDurationHours(label: string): number {
  const match = /^(\d+)(m|h|d|mo|y)$/.exec(label)
  if (!match) return 0
  const value = Number.parseInt(match[1]!, 10)
  switch (match[2]) {
    case "m":
      return value / 60
    case "h":
      return value
    case "d":
      return value * 24
    case "mo":
      return value * 30 * 24
    case "y":
      return value * 365 * 24
    default:
      return 0
  }
}

function formatHours(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24}d`
  return `${hours}h`
}

function newestUnresolvedThreadTime(item: ReviewQueueItemView): number {
  return item.reviewThreads
    .filter((thread) => thread.status === "unresolved")
    .reduce(
      (latest, thread) =>
        Math.max(latest, Date.parse(thread.lastActivityAtIso ?? "") || 0),
      0
    )
}

function maxBy<T>(items: T[], getValue: (item: T) => number | undefined): T | undefined {
  let best: T | undefined
  let bestValue = -Infinity
  for (const item of items) {
    const value = getValue(item)
    if (value === undefined || Number.isNaN(value)) continue
    if (!best || value > bestValue) {
      best = item
      bestValue = value
    }
  }
  return best
}

function startOfLocalDay(time: number): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dateKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function formatShortDate(time: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(time))
}
