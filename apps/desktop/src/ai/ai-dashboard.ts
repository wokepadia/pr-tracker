import type { ReviewerInsightsView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

export interface AiDashboardPrInput {
  id: string
  repository: string
  number: number
  title: string
  description?: string
  authorLogin: string
  waitingOn: string
  waitingAge: string
  openedAt: string
  updatedAt: string
  state: string
  reason: string
  chips: string[]
  unseenEvents: string[]
  fileCount?: number
  lineCount?: number
  newCommitCount: number
  newReplyCount: number
  unresolvedThreadCount: number
  totalThreadCount: number
  reviewRounds: number
  checksState?: string
  labels: string[]
  unresolvedThreads: Array<{
    excerpt: string
    lastActorLogin?: string
    lastActivityAt?: string
    awaitingYourReply: boolean
  }>
  discussionExcerpts?: Array<{
    actor: string
    body: string
    occurredAt: string
    source: "issue_comment" | "review_comment" | "review"
    filePath?: string
    line?: number
  }>
}

export interface AiDashboardInput {
  metrics: {
    openReviewCount: number
    repositoryCount: number
    yourMoveCount: number
    waitingOnAuthorCount: number
    stalledCount: number
    activeSinceLastVisitCount: number
    omittedCount: number
    sinceWindowLabel?: string
  }
  items: AiDashboardPrInput[]
}

export interface AiDashboardContent {
  queueSummary: {
    body: string
    bullets: Array<{ tone: "urgent" | "stalled" | "quick_win" | "info"; text: string }>
  }
  sinceLastVisit: {
    body: string
    bullets: string[]
  }
  cards: Array<{
    pullRequestId: string
    summary: string
    sinceYouLooked: string
    nextAction: string
  }>
}

const maxInputItems = 30
const maxUnseenEventsPerItem = 6
const maxDiscussionExcerptsPerItem = 5
const maxDiscussionExcerptChars = 500
const maxSummaryBullets = 4
const maxSinceBullets = 5
const maxCards = 18

const sectionLabels: Array<{
  key:
    | "needsYouNow"
    | "mightBeMissing"
    | "stalledOnYou"
    | "whileAway"
    | "hygiene"
  label: string
}> = [
  { key: "needsYouNow", label: "needs you now" },
  { key: "mightBeMissing", label: "might be missing" },
  { key: "stalledOnYou", label: "stalled on you" },
  { key: "whileAway", label: "finished while away" },
  { key: "hygiene", label: "aging" },
]

export function buildAiDashboardInput(
  insights: ReviewerInsightsView,
  items: ReviewQueueItemView[]
): AiDashboardInput {
  const openItems = items.filter((item) => item.state === "open")
  const itemById = new Map(openItems.map((item) => [item.id, item]))
  const chipsById = new Map<string, string[]>()

  for (const section of sectionLabels) {
    for (const row of insights[section.key]) {
      if (!itemById.has(row.item.id)) continue
      const chips = chipsById.get(row.item.id) ?? []
      chips.push(`${section.label}: ${row.whyChip}`)
      chipsById.set(row.item.id, chips)
    }
  }

  const ordered = openItems.slice().sort(compareDashboardItems)
  const within = ordered.slice(0, maxInputItems)

  return {
    metrics: {
      openReviewCount: openItems.length,
      repositoryCount: new Set(openItems.map((item) => item.repository)).size,
      yourMoveCount: openItems.filter((item) => item.waitingOn === "you").length,
      waitingOnAuthorCount: openItems.filter(
        (item) => item.waitingOn === "author"
      ).length,
      stalledCount: openItems.filter(
        (item) =>
          item.workflowState === "stale" || item.waitingUrgency === "overdue"
      ).length,
      activeSinceLastVisitCount: openItems.filter(
        (item) => item.unseenEventCount > 0
      ).length,
      omittedCount: Math.max(0, ordered.length - within.length),
      sinceWindowLabel: insights.digest
        ? `${insights.digest.updatedPullRequestCount} updated since ${
            insights.digest.windowStartAt
          }`
        : undefined,
    },
    items: within.map((item) => ({
      id: item.id,
      repository: item.repository,
      number: item.number,
      title: item.title,
      description: item.description,
      authorLogin: item.authorLogin,
      waitingOn: item.waitingOn,
      waitingAge: item.waitingAge,
      openedAt: item.openedAt,
      updatedAt: item.updatedAt,
      state: item.state,
      reason: item.reason,
      chips: chipsById.get(item.id) ?? [],
      unseenEvents: item.activityEvents
        .filter((event) => event.isNew)
        .slice(0, maxUnseenEventsPerItem)
        .map((event) => `${event.actor} ${event.action}`),
      fileCount: item.size?.fileCount,
      lineCount: item.size?.lineCount,
      newCommitCount: item.newCommitCount,
      newReplyCount: item.newReplyCount,
      unresolvedThreadCount: item.unresolvedThreadCount,
      totalThreadCount: item.totalThreadCount,
      reviewRounds: item.reviewRounds,
      checksState: item.checks?.state,
      labels: item.labels.map((label) => label.name).slice(0, 6),
      unresolvedThreads: item.reviewThreads
        .filter((thread) => thread.status === "unresolved")
        .slice(0, 4)
        .map((thread) => ({
          excerpt: thread.excerpt,
          lastActorLogin: thread.lastActorLogin,
          lastActivityAt: thread.lastActivityAtIso,
          awaitingYourReply: thread.awaitingYourReply,
        })),
    })),
  }
}

function compareDashboardItems(
  a: ReviewQueueItemView,
  b: ReviewQueueItemView
): number {
  return (
    turnWeight(a) - turnWeight(b) ||
    urgencyWeight(a) - urgencyWeight(b) ||
    b.unseenEventCount - a.unseenEventCount ||
    Date.parse(b.updatedAtIso) - Date.parse(a.updatedAtIso) ||
    a.repository.localeCompare(b.repository) ||
    a.number - b.number
  )
}

function turnWeight(item: ReviewQueueItemView): number {
  if (item.waitingOn === "you") return 0
  if (item.waitingOn === "author") return 1
  return 2
}

function urgencyWeight(item: ReviewQueueItemView): number {
  if (item.waitingUrgency === "overdue") return 0
  if (item.workflowState === "stale") return 1
  if (item.waitingUrgency === "elevated") return 2
  return 3
}

export const aiDashboardSchemaName = "ai_dashboard"

export const aiDashboardSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["queueSummary", "sinceLastVisit", "cards"],
  properties: {
    queueSummary: {
      type: "object",
      additionalProperties: false,
      required: ["body", "bullets"],
      properties: {
        body: {
          type: "string",
          description:
            "Two short sentences in the style of 'You have 9 open reviews across 4 repos - 4 in your court, 5 with their authors.'",
        },
        bullets: {
          type: "array",
          maxItems: maxSummaryBullets,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tone", "text"],
            properties: {
              tone: {
                type: "string",
                enum: ["urgent", "stalled", "quick_win", "info"],
              },
              text: { type: "string" },
            },
          },
        },
      },
    },
    sinceLastVisit: {
      type: "object",
      additionalProperties: false,
      required: ["body", "bullets"],
      properties: {
        body: {
          type: "string",
          description:
            "One or two sentences about what changed since the reviewer last looked.",
        },
        bullets: {
          type: "array",
          maxItems: maxSinceBullets,
          items: { type: "string" },
        },
      },
    },
    cards: {
      type: "array",
      maxItems: maxCards,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequestId", "summary", "sinceYouLooked", "nextAction"],
        properties: {
          pullRequestId: {
            type: "string",
            description: "A pull request id exactly as listed.",
          },
          summary: {
            type: "string",
            description:
              "Two concise sentences explaining the review state, not the code quality.",
          },
          sinceYouLooked: {
            type: "string",
            description:
              "One concise paragraph describing new activity since the reviewer last looked. Say 'No changes since your review' only when the listed facts support it.",
          },
          nextAction: {
            type: "string",
            description:
              "One concrete next step for the reviewer or author, based only on the waiting side and listed facts.",
          },
        },
      },
    },
  },
}

export function buildAiDashboardPrompt(input: AiDashboardInput): {
  system: string
  user: string
} {
  const system = [
    "You write a pure turn-tracking dashboard for a code reviewer's pull request queue.",
    "Use only the pull requests, metrics, and facts listed; never invent pull requests, events, statuses, or people.",
    "Do not assess code quality, implementation risk, reviewer performance, or whether the code is correct.",
    "Explain what happened since the reviewer looked, whose court each pull request is in, exactly who does what next, and whether it is stalled.",
    "The deterministic waiting side, counts, check state, and flags are authoritative.",
    "Reference pull requests only by their listed id in card objects.",
    "Keep wording direct and concrete, similar to a review-flow wireframe, but do not mention the wireframe.",
  ].join(" ")

  const lines: string[] = [
    "Board-scoped review queue metrics:",
    `- open reviews: ${input.metrics.openReviewCount}`,
    `- repositories: ${input.metrics.repositoryCount}`,
    `- in your court: ${input.metrics.yourMoveCount}`,
    `- with their authors: ${input.metrics.waitingOnAuthorCount}`,
    `- stalled: ${input.metrics.stalledCount}`,
    `- saw activity since last visit: ${input.metrics.activeSinceLastVisitCount}`,
  ]
  if (input.metrics.sinceWindowLabel) {
    lines.push(`- since-window: ${input.metrics.sinceWindowLabel}`)
  }
  if (input.metrics.omittedCount > 0) {
    lines.push(`- omitted lower-priority open reviews: ${input.metrics.omittedCount}`)
  }

  lines.push("", "Pull requests:")
  for (const item of input.items) {
    lines.push(
      `- id ${item.id} | ${item.repository}#${item.number} | ${item.title}`,
      `  author: ${item.authorLogin}`,
      `  waiting on: ${item.waitingOn}${
        item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
      }`,
      `  opened: ${item.openedAt}; active: ${item.updatedAt}`,
      `  reason: ${item.reason}`
    )
    if (item.description) {
      lines.push(`  description: ${truncateText(item.description, 220)}`)
    }
    if (item.chips.length > 0) {
      for (const chip of item.chips) lines.push(`  flag - ${chip}`)
    }
    lines.push(
      `  facts: ${formatMaybeNumber(item.fileCount, "files")}; ${formatMaybeNumber(
        item.lineCount,
        "changed lines"
      )}; ${formatCount(item.newCommitCount, "new commit")}; ${formatCount(
        item.newReplyCount,
        "new reply"
      )}; ${item.unresolvedThreadCount}/${item.totalThreadCount} unresolved threads; ${item.reviewRounds} review rounds; checks ${item.checksState ?? "unknown"}`
    )
    if (item.labels.length > 0) {
      lines.push(`  labels: ${item.labels.join(", ")}`)
    }
    if (item.unseenEvents.length > 0) {
      lines.push(`  since last seen: ${item.unseenEvents.join("; ")}`)
    }
    for (const thread of item.unresolvedThreads) {
      lines.push(
        `  unresolved thread: ${thread.excerpt}; last actor ${
          thread.lastActorLogin ?? "unknown"
        }${thread.lastActivityAt ? ` at ${thread.lastActivityAt}` : ""}; ${
          thread.awaitingYourReply ? "awaiting reviewer reply" : "awaiting author reply"
        }`
      )
    }
    for (const excerpt of (item.discussionExcerpts ?? []).slice(
      -maxDiscussionExcerptsPerItem
    )) {
      const location = excerpt.filePath
        ? ` on ${excerpt.filePath}${excerpt.line ? `:${excerpt.line}` : ""}`
        : ""
      lines.push(
        `  discussion - [${excerpt.occurredAt}] ${excerpt.source}${location} by ${excerpt.actor}:`,
        indentBlock(truncateText(excerpt.body, maxDiscussionExcerptChars))
      )
    }
  }

  lines.push(
    "",
    "Write the dashboard fields. The queue summary should call out the most important blockers, author-side stalls, and quick wins when supported. The since-last-visit section should only describe listed activity. Create one card for each listed pull request that matters to the review flow, preserving the listed id. Leave out low-signal cards only when there are too many."
  )

  return { system, user: lines.join("\n") }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function formatMaybeNumber(value: number | undefined, noun: string): string {
  return value === undefined ? `unknown ${noun}` : formatCount(value, noun)
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n(truncated)`
}

export function normalizeAiDashboardContent(
  value: unknown,
  allowedIds: string[]
): AiDashboardContent {
  const parsed = (value ?? {}) as {
    queueSummary?: unknown
    sinceLastVisit?: unknown
    cards?: unknown
  }
  const queueSummary = normalizeTextBlock(
    parsed.queueSummary,
    "queue summary",
    maxSummaryBullets
  )
  const sinceLastVisit = normalizeTextBlock(
    parsed.sinceLastVisit,
    "since-last-visit summary",
    maxSinceBullets
  )

  const allowed = new Set(allowedIds)
  const seen = new Set<string>()
  const cards: AiDashboardContent["cards"] = []
  if (Array.isArray(parsed.cards)) {
    for (const entry of parsed.cards) {
      const candidate = (entry ?? {}) as Record<string, unknown>
      const pullRequestId =
        typeof candidate.pullRequestId === "string"
          ? candidate.pullRequestId.trim()
          : ""
      if (!pullRequestId || !allowed.has(pullRequestId) || seen.has(pullRequestId)) {
        continue
      }
      const summary = text(candidate.summary)
      const sinceYouLooked = text(candidate.sinceYouLooked)
      const nextAction = text(candidate.nextAction)
      if (!summary || !sinceYouLooked || !nextAction) continue
      seen.add(pullRequestId)
      cards.push({ pullRequestId, summary, sinceYouLooked, nextAction })
      if (cards.length >= maxCards) break
    }
  }

  return {
    queueSummary: {
      body: queueSummary.body,
      bullets: queueSummary.bullets.map((bullet) =>
        typeof bullet === "string"
          ? { tone: "info" as const, text: bullet }
          : bullet
      ),
    },
    sinceLastVisit: {
      body: sinceLastVisit.body,
      bullets: sinceLastVisit.bullets.map((bullet) =>
        typeof bullet === "string" ? bullet : bullet.text
      ),
    },
    cards,
  }
}

function normalizeTextBlock(
  value: unknown,
  label: string,
  maxBullets: number
): {
  body: string
  bullets: Array<string | { tone: "urgent" | "stalled" | "quick_win" | "info"; text: string }>
} {
  const parsed = (value ?? {}) as { body?: unknown; bullets?: unknown }
  const body = text(parsed.body)
  if (!body) {
    throw new Error(`The model response was missing the ${label}.`)
  }

  const bullets: Array<
    string | { tone: "urgent" | "stalled" | "quick_win" | "info"; text: string }
  > = []
  if (Array.isArray(parsed.bullets)) {
    for (const bullet of parsed.bullets) {
      if (typeof bullet === "string") {
        const value = text(bullet)
        if (value) bullets.push(value)
      } else {
        const candidate = (bullet ?? {}) as Record<string, unknown>
        const value = text(candidate.text)
        if (!value) continue
        const tone =
          candidate.tone === "urgent" ||
          candidate.tone === "stalled" ||
          candidate.tone === "quick_win" ||
          candidate.tone === "info"
            ? candidate.tone
            : "info"
        bullets.push({ tone, text: value })
      }
      if (bullets.length >= maxBullets) break
    }
  }

  return { body, bullets }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
