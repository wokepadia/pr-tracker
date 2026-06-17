import type { ReviewQueueItemView } from "@/reviewer/view-model"

/**
 * Turn-tracking dashboard input/prompt/schema. The dashboard narrates the
 * board-scoped review queue: what changed since the reviewer last looked,
 * whose court each pull request is in, what happens next, and whether
 * anything is stalled. It never assesses the code itself.
 *
 * The input is derived directly from the board-scoped view-model items, so
 * the model gets raw turn facts rather than pre-chewed section labels.
 * Everything is pure so the exact prompt text — and the cache key derived
 * from it — stays deterministic and testable.
 */

export interface AiDashboardThreadInput {
  excerpt: string
  lastActorLogin?: string
  awaitingYourReply: boolean
}

export interface AiDashboardReviewerInput {
  login: string
  decision: string
}

export interface AiDashboardSinceLastReviewInput {
  decision: string
  reviewedAt: string
  commitCount: number
  replyCount: number
  threadsResolvedCount: number
}

export interface AiDashboardPrInput {
  id: string
  repository: string
  number: number
  title: string
  description?: string
  authorLogin: string
  waitingOn: string
  waitingAge: string
  waitingUrgency: string
  isStalled: boolean
  openedAt: string
  updatedAt: string
  state: string
  reason: string
  additions?: number
  deletions?: number
  fileCount?: number
  newCommitCount: number
  newReplyCount: number
  unresolvedThreadCount: number
  totalThreadCount: number
  awaitingYourReplyCount: number
  reviewRounds: number
  checksState?: string
  approvalStale: boolean
  userLastReviewDecision: string
  labels: string[]
  otherReviewers: AiDashboardReviewerInput[]
  sinceLastReview?: AiDashboardSinceLastReviewInput
  unseenEvents: string[]
  unresolvedThreads: AiDashboardThreadInput[]
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
    /** Relative time since the reviewer's previous visit, e.g. "2h ago". */
    sinceVisitLabel?: string
  }
  items: AiDashboardPrInput[]
}

export interface AiDashboardContent {
  queueSummary: {
    body: string
    bullets: Array<{
      tone: "urgent" | "stalled" | "quick_win" | "info"
      text: string
    }>
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
const maxUnseenEventsPerItem = 8
const maxUnresolvedThreadsPerItem = 4
const maxDiscussionExcerptsPerItem = 5
const maxDiscussionExcerptChars = 500
const maxSummaryBullets = 4
const maxSinceBullets = 5
const maxCards = 18

export function buildAiDashboardInput(
  items: ReviewQueueItemView[],
  options: { sinceVisitLabel?: string } = {}
): AiDashboardInput {
  const openItems = items.filter((item) => item.state === "open")
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
      stalledCount: openItems.filter(isStalled).length,
      activeSinceLastVisitCount: openItems.filter(
        (item) => item.unseenEventCount > 0
      ).length,
      omittedCount: Math.max(0, ordered.length - within.length),
      sinceVisitLabel: options.sinceVisitLabel,
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
      waitingUrgency: item.waitingUrgency,
      isStalled: isStalled(item),
      openedAt: item.openedAt,
      updatedAt: item.updatedAt,
      state: item.state,
      reason: item.reason,
      additions: item.size?.additions,
      deletions: item.size?.deletions,
      fileCount: item.size?.fileCount,
      newCommitCount: item.newCommitCount,
      newReplyCount: item.newReplyCount,
      unresolvedThreadCount: item.unresolvedThreadCount,
      totalThreadCount: item.totalThreadCount,
      awaitingYourReplyCount: item.reviewThreads.filter(
        (thread) => thread.status === "unresolved" && thread.awaitingYourReply
      ).length,
      reviewRounds: item.reviewRounds,
      checksState: item.checks?.state,
      approvalStale: item.approvalStale,
      userLastReviewDecision: item.userLastReviewDecision,
      labels: item.labels.map((label) => label.name).slice(0, 6),
      otherReviewers: item.otherReviewers.map((reviewer) => ({
        login: reviewer.login,
        decision: reviewer.decision,
      })),
      sinceLastReview: item.sinceLastReview
        ? {
            decision: item.sinceLastReview.decision,
            reviewedAt: item.sinceLastReview.reviewedAt,
            commitCount: item.sinceLastReview.commits.length,
            replyCount: item.sinceLastReview.replyCount,
            threadsResolvedCount: item.sinceLastReview.threadsResolvedCount,
          }
        : undefined,
      unseenEvents: item.activityEvents
        .filter((event) => event.isNew)
        .slice(0, maxUnseenEventsPerItem)
        .map((event) => `${event.actor} ${event.action}`),
      unresolvedThreads: item.reviewThreads
        .filter((thread) => thread.status === "unresolved")
        .slice(0, maxUnresolvedThreadsPerItem)
        .map((thread) => ({
          excerpt: thread.excerpt,
          lastActorLogin: thread.lastActorLogin,
          awaitingYourReply: thread.awaitingYourReply,
        })),
    })),
  }
}

function isStalled(item: ReviewQueueItemView): boolean {
  return item.workflowState === "stale" || item.waitingUrgency === "overdue"
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
            "One or two sentences of totals in the style of 'You have 9 open reviews across 4 repos — 4 in your court, 5 with their authors.', ending with a lead-in like 'A few things deserve attention first:' when there are clear priorities.",
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
              text: {
                type: "string",
                description:
                  "A priority callout naming specific pull requests by #number, grouping related ones, with a short recommendation (e.g. 'start here', 'worth a nudge', 'just need a re-review').",
              },
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
            "One sentence on how many reviews saw activity since the reviewer last looked and the overall shape of the movement.",
        },
        bullets: {
          type: "array",
          maxItems: maxSinceBullets,
          items: {
            type: "string",
            description:
              "A reviewer-actionable takeaway about the movement: which reviews are back in your court (the author addressed your asks or re-requested you) and which have gone quiet on the author, naming the pull requests by #number. Lead with the consequence, not a per-actor activity log, and never headline a raw count.",
          },
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
              "Two or three sentences: when it opened, what you raised, what the author has done since, and the current blocking state. Review flow only, never code quality.",
          },
          sinceYouLooked: {
            type: "string",
            description:
              "One short paragraph on what changed that affects your decision: whether the author addressed your change requests (in code or only in discussion), whether the ball is back in your court, whether anything invalidated your prior review. Lead with the implication, not an event list or counts. Say 'No changes since your review' only when the listed facts support it.",
          },
          nextAction: {
            type: "string",
            description:
              "One concrete next step for the reviewer or author, grounded in the waiting side and listed facts.",
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
    "You write a turn-tracking dashboard for a code reviewer's pull request queue.",
    "Use only the pull requests, metrics, and facts listed; never invent pull requests, events, statuses, people, or numbers.",
    "Do not assess code quality, implementation risk, reviewer performance, or whether the code is correct.",
    "Explain what changed since the reviewer last looked and what it means for them, whose court each pull request is in, exactly who does what next, and whether it is stalled.",
    "When you report movement, lead with its consequence for the reviewer — never replay a per-actor activity log or headline a raw count.",
    "The deterministic waiting side, counts, check state, and flags are authoritative; never contradict them.",
    "Write in a direct, concrete, second-person voice addressed to the reviewer ('you'), naming the actors who acted.",
    "Reference pull requests by their #number in prose, and by their listed id only inside card objects.",
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
  if (input.metrics.sinceVisitLabel) {
    lines.push(`- reviewer last visited: ${input.metrics.sinceVisitLabel}`)
  }
  if (input.metrics.omittedCount > 0) {
    lines.push(
      `- omitted lower-priority open reviews: ${input.metrics.omittedCount}`
    )
  }

  lines.push("", "Pull requests, highest priority first:")
  for (const item of input.items) {
    lines.push(
      `- id ${item.id} | ${item.repository}#${item.number} | ${item.title}`,
      `  author: ${item.authorLogin}`,
      `  waiting on: ${item.waitingOn}${
        item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
      } (urgency ${item.waitingUrgency}${item.isStalled ? ", stalled" : ""})`,
      `  opened: ${item.openedAt}; active: ${item.updatedAt}`,
      `  reason: ${item.reason}`
    )
    if (item.description) {
      lines.push(`  description: ${truncateText(item.description, 220)}`)
    }
    lines.push(
      `  your last review: ${item.userLastReviewDecision}${
        item.approvalStale ? " (now stale — branch moved after you approved)" : ""
      }`
    )
    if (item.otherReviewers.length > 0) {
      lines.push(
        `  other reviewers: ${item.otherReviewers
          .map((reviewer) => `${reviewer.login} ${reviewer.decision}`)
          .join(", ")}`
      )
    }
    lines.push(
      `  facts: ${formatDiff(item.additions, item.deletions)}; ${formatMaybeNumber(
        item.fileCount,
        "files"
      )}; ${formatCount(item.newCommitCount, "new commit")}; ${formatCount(
        item.newReplyCount,
        "new reply"
      )}; ${item.unresolvedThreadCount}/${item.totalThreadCount} unresolved threads (${
        item.awaitingYourReplyCount
      } awaiting your reply); ${item.reviewRounds} changes-requested rounds; checks ${
        item.checksState ?? "unknown"
      }`
    )
    if (item.sinceLastReview) {
      lines.push(
        `  since your last review (${item.sinceLastReview.decision} ${item.sinceLastReview.reviewedAt}): ${formatCount(
          item.sinceLastReview.commitCount,
          "commit"
        )}, ${formatCount(item.sinceLastReview.replyCount, "reply")}, ${formatCount(
          item.sinceLastReview.threadsResolvedCount,
          "thread"
        )} resolved`
      )
    }
    if (item.labels.length > 0) {
      lines.push(`  labels: ${item.labels.join(", ")}`)
    }
    if (item.unseenEvents.length > 0) {
      lines.push(`  since you last looked: ${item.unseenEvents.join("; ")}`)
    }
    for (const thread of item.unresolvedThreads) {
      lines.push(
        `  unresolved thread: ${thread.excerpt}; last actor ${
          thread.lastActorLogin ?? "unknown"
        }; ${
          thread.awaitingYourReply
            ? "awaiting your reply"
            : "awaiting author reply"
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
    "Write the dashboard fields:",
    "- queueSummary.body: state the totals (open reviews, repos, how many are in your court vs with their authors), then lead into the priorities.",
    "- queueSummary.bullets: 2-4 callouts, each naming specific pull requests by #number and grouping related ones. Lead with the most urgent blocker on your side (tone urgent), then author-side reviews that have gone quiet and are worth a nudge (tone stalled), then quick wins already addressed that just need a re-review (tone quick_win). End each with a short recommendation.",
    "- sinceLastVisit.body: one sentence on how many of your reviews saw activity and the overall shape of the movement.",
    "- sinceLastVisit.bullets: turn the movement into reviewer-actionable takeaways — which reviews are back in your court (the author pushed commits addressing your asks, or re-requested you) versus which have gone quiet on the author. Name pull requests by #number, lead with the consequence, and keep counts out of the headline.",
    "- cards: one card for each listed pull request, preserving the listed id. Cover the review state only, never the code's correctness."
  )

  return { system, user: lines.join("\n") }
}

function formatDiff(
  additions: number | undefined,
  deletions: number | undefined
): string {
  if (additions === undefined && deletions === undefined) {
    return "unknown diff size"
  }
  return `+${additions ?? 0} -${deletions ?? 0}`
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
      if (
        !pullRequestId ||
        !allowed.has(pullRequestId) ||
        seen.has(pullRequestId)
      ) {
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
  bullets: Array<
    string | { tone: "urgent" | "stalled" | "quick_win" | "info"; text: string }
  >
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
