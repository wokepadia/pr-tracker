import type { ReviewQueueItemView } from "./view-model"

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

const hourMs = 60 * 60 * 1000

export function buildAiDashboardStats(input: {
  items: ReviewQueueItemView[]
  now?: number
}): AiDashboardStats {
  const now = input.now ?? Date.now()
  const activeItems = input.items.filter((item) => item.state === "open")
  const waitingOnYouItems = activeItems.filter((item) => item.waitingOn === "you")

  return {
    repositoryBreakdown: buildRepositoryBreakdown(activeItems, now),
    discussionHotspots: buildDiscussionHotspots(activeItems),
    authorsWaiting: buildAuthorsWaiting(waitingOnYouItems, now),
  }
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

function newestUnresolvedThreadTime(item: ReviewQueueItemView): number {
  return item.reviewThreads
    .filter((thread) => thread.status === "unresolved")
    .reduce(
      (latest, thread) =>
        Math.max(latest, Date.parse(thread.lastActivityAtIso ?? "") || 0),
      0
    )
}
