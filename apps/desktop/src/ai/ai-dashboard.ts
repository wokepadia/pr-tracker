import { hashContent } from "./content-hash"
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

/** The user-facing per-pull-request card shown on the dashboard. */
export interface AiDashboardCard {
  pullRequestId: string
  summary: string
  sinceYouLooked: string
  nextAction: string
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
  cards: AiDashboardCard[]
}

/**
 * A card as produced by one generation pass. It carries the user-facing fields
 * plus an uncapped, machine-friendly record persisted per card and fed back as
 * context the next time the card is unchanged. The machine summary is never
 * shown to the reviewer.
 */
export interface GeneratedDashboardCard extends AiDashboardCard {
  machineSummary: string
}

/**
 * The raw model output for a generation pass. The model writes the holistic
 * sections over the whole board, but only writes cards for the pull requests it
 * was given in full (the changed ones); unchanged cards are carried over from
 * their stored rows by the caller.
 */
export interface AiDashboardGeneration {
  queueSummary: AiDashboardContent["queueSummary"]
  sinceLastVisit: AiDashboardContent["sinceLastVisit"]
  cards: GeneratedDashboardCard[]
}

/** A pull request sent as context only, with the machine summary written before. */
export interface DashboardReferenceItem {
  item: AiDashboardPrInput
  machineSummary: string
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
  if (a.unansweredReviewRequest !== b.unansweredReviewRequest) {
    return a.unansweredReviewRequest ? -1 : 1
  }
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

/**
 * A stable string capturing every card input the prompt is grounded in. Any
 * change to the card's facts — its updatedAt, new commits, threads, discussion
 * excerpts, or unseen events — changes this string, and so its fingerprint.
 */
function serializeCardForFingerprint(item: AiDashboardPrInput): string {
  return JSON.stringify(item)
}

/**
 * Fingerprints one card's full input under a model. The model is folded in so a
 * model switch invalidates every card and forces a full regeneration.
 */
export async function fingerprintCard(
  item: AiDashboardPrInput,
  model: string
): Promise<string> {
  return hashContent(`${model}\n${serializeCardForFingerprint(item)}`)
}

/** Fingerprints a list of cards, keyed by pull request id. */
export async function fingerprintCards(
  items: AiDashboardPrInput[],
  model: string
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    items.map(
      async (item) => [item.id, await fingerprintCard(item, model)] as const
    )
  )
  return new Map(entries)
}

/**
 * Splits the board items into the ones that need a fresh AI read (`full`: no
 * stored card, or a fingerprint that no longer matches) and the ones whose
 * stored summary can be reused as context (`reference`).
 */
export function partitionDashboardItems(
  items: AiDashboardPrInput[],
  fingerprints: Map<string, string>,
  stored: Map<string, { fingerprint: string }>
): { full: AiDashboardPrInput[]; reference: AiDashboardPrInput[] } {
  const full: AiDashboardPrInput[] = []
  const reference: AiDashboardPrInput[] = []
  for (const item of items) {
    const row = stored.get(item.id)
    if (row && row.fingerprint === fingerprints.get(item.id)) {
      reference.push(item)
    } else {
      full.push(item)
    }
  }
  return { full, reference }
}

/**
 * Assembles the final card list in board-priority order, preferring a freshly
 * generated card and falling back to the carried-over stored card. Ids with
 * neither are dropped.
 */
export function mergeDashboardCards(
  orderedIds: string[],
  fresh: AiDashboardCard[],
  carried: Map<string, AiDashboardCard>
): AiDashboardCard[] {
  const freshById = new Map(fresh.map((card) => [card.pullRequestId, card]))
  const cards: AiDashboardCard[] = []
  for (const id of orderedIds) {
    const card = freshById.get(id) ?? carried.get(id)
    if (card) cards.push(card)
  }
  return cards
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
            "Two to three sentences: the totals worth knowing (how many reviews are in your court versus with their authors) and the overall shape, ending with a lead-in like 'A few things deserve attention first:' when there are clear priorities. Do not mention how many reviews 'saw activity' or how many were omitted from the view.",
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
                  "A priority callout of a sentence or two, naming the specific pull requests by #number with a short recommendation (e.g. 'start here', 'worth a nudge', 'just need a re-review'). Never enumerate a long list of #numbers — when a group is large (e.g. stalled drafts), collapse it into a count and one characterization rather than listing them all.",
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
            "Two to three sentences on the shape of what moved since you last looked — which way the queue tilted (back to you versus still with their authors) and the few reviews that now need you. Do not open with a raw 'N reviews saw activity' count.",
        },
        bullets: {
          type: "array",
          maxItems: maxSinceBullets,
          items: {
            type: "string",
            description:
              "A reviewer-actionable takeaway of a sentence or two about the movement: which reviews are back in your court (the author addressed your asks or re-requested you) and why, naming those pull requests by #number. Lead with the consequence, not a per-actor activity log; never headline a raw count, and never re-list the same stalled #numbers another bullet already covered.",
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
        required: [
          "pullRequestId",
          "summary",
          "sinceYouLooked",
          "nextAction",
          "machineSummary",
        ],
        properties: {
          pullRequestId: {
            type: "string",
            description: "A pull request id exactly as listed.",
          },
          summary: {
            type: "string",
            description:
              "Three to four sentences on what this PR is about and where your review stands: what it changes (from its title, description, and threads), what you raised, what the author has done since, and the single open point blocking your sign-off. No age or turn-state recitation, no raw counts.",
          },
          sinceYouLooked: {
            type: "string",
            description:
              "A short paragraph of two to four sentences on what changed that affects your decision: whether the author addressed your change requests (in code or only in discussion), whether the ball is back in your court, whether anything invalidated your prior review. Lead with the implication; never restate raw counts (e.g. 'N replies, no new commits'), an unknown or green check status, or turn mechanics. Say 'No changes since your review' only when the listed facts support it.",
          },
          nextAction: {
            type: "string",
            description:
              "One or two sentences spelling out the concrete next step for the reviewer or author, grounded in the waiting side and listed facts.",
          },
          machineSummary: {
            type: "string",
            description:
              "A thorough, accurate, self-contained record of this pull request for later reuse — what it changes, where each review thread stands, what was decided and why, and the open points. No length limit and no reader-facing styling: it is stored and fed back as context the next time this card is unchanged, so it must stand on its own without the raw data. Stay grounded in the listed facts; never invent.",
          },
        },
      },
    },
  },
}

const dashboardSystemLines = [
  "You write a reviewer's queue brief: orient a reviewer to which of their open pull requests need action and why, with real substance.",
  "Use only the pull requests, metrics, and facts listed; never invent pull requests, events, statuses, people, or numbers.",
  "Do not declare code correct or incorrect or invent risks; you may say what a pull request is about and what is contested, grounded in the listed titles, descriptions, threads, and discussion.",
  "Lead with what matters to the reviewer: which reviews are back in their court and why, and the open point on each — not turn bookkeeping.",
  "Never pad with stats or absent data: do not recite raw counts (new commits, replies, thread totals), the waiting age or how long a PR has been open, or an unknown or green check status; never enumerate a long list of pull-request numbers — collapse a large group into a count and one characterization (for example '~20 stalled drafts still with their authors').",
  "State each fact once; do not repeat the same pull requests across bullets and fields.",
  "The deterministic waiting side is authoritative; never contradict it.",
  "Write in a direct, concrete, second-person voice addressed to the reviewer ('you'), naming the actors who acted.",
  "Reference pull requests by their #number in prose, and by their listed id only inside card objects.",
]

const dashboardReferenceSystemLine =
  "Some pull requests are listed as context only, each with an authoritative summary you wrote before; rely on it as fact for the holistic sections, but do not write cards for them."

/** Renders the full, detailed prompt block for one pull request. */
function renderCardDetail(item: AiDashboardPrInput): string[] {
  const lines: string[] = [
    `- id ${item.id} | ${item.repository}#${item.number} | ${item.title}`,
    `  author: ${item.authorLogin}`,
    `  waiting on: ${item.waitingOn}${
      item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
    } (urgency ${item.waitingUrgency}${item.isStalled ? ", stalled" : ""})`,
    `  opened: ${item.openedAt}; active: ${item.updatedAt}`,
    `  reason: ${item.reason}`,
  ]
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
    `  facts (grounding only — do not recite as stats): ${formatDiff(
      item.additions,
      item.deletions
    )} across ${formatMaybeNumber(item.fileCount, "files")}; ${formatCount(
      item.newCommitCount,
      "new commit"
    )} and ${formatCount(
      item.newReplyCount,
      "new reply"
    )} since you last looked; ${item.unresolvedThreadCount}/${
      item.totalThreadCount
    } unresolved threads (${item.awaitingYourReplyCount} awaiting your reply); ${
      item.reviewRounds
    } changes-requested rounds`
  )
  if (item.checksState === "failure" || item.checksState === "pending") {
    lines.push(`  checks: ${item.checksState}`)
  }
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
  return lines
}

/**
 * Renders the compact, context-only block for an unchanged pull request: just
 * its turn facts plus the stored machine summary, so the holistic sections stay
 * grounded without re-sending the raw threads and discussion.
 */
function renderCardReference(
  item: AiDashboardPrInput,
  machineSummary: string
): string[] {
  return [
    `- id ${item.id} | ${item.repository}#${item.number} | ${item.title}`,
    `  author: ${item.authorLogin}`,
    `  waiting on: ${item.waitingOn}${
      item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
    } (urgency ${item.waitingUrgency}${item.isStalled ? ", stalled" : ""})`,
    "  known summary (authoritative — reuse, do not re-derive):",
    indentBlock(machineSummary),
  ]
}

function buildDashboardPrompt(args: {
  metrics: AiDashboardInput["metrics"]
  fullItems: AiDashboardPrInput[]
  referenceItems: DashboardReferenceItem[]
}): { system: string; user: string } {
  const { metrics, fullItems, referenceItems } = args
  const hasReference = referenceItems.length > 0

  const system = [
    ...dashboardSystemLines,
    ...(hasReference ? [dashboardReferenceSystemLine] : []),
  ].join(" ")

  const lines: string[] = [
    "Board-scoped review queue metrics:",
    `- open reviews: ${metrics.openReviewCount}`,
    `- repositories: ${metrics.repositoryCount}`,
    `- in your court: ${metrics.yourMoveCount}`,
    `- with their authors: ${metrics.waitingOnAuthorCount}`,
    `- stalled: ${metrics.stalledCount}`,
  ]
  if (metrics.sinceVisitLabel) {
    lines.push(`- reviewer last visited: ${metrics.sinceVisitLabel}`)
  }

  lines.push(
    "",
    hasReference
      ? "Pull requests needing a fresh read (write a card for each, highest priority first):"
      : "Pull requests, highest priority first:"
  )
  for (const item of fullItems) {
    lines.push(...renderCardDetail(item))
  }

  if (hasReference) {
    lines.push(
      "",
      "Other open pull requests (context only — reuse the known summary; do NOT write cards for these):"
    )
    for (const reference of referenceItems) {
      lines.push(...renderCardReference(reference.item, reference.machineSummary))
    }
  }

  lines.push(
    "",
    "Write the dashboard fields:",
    "- queueSummary.body: state the totals worth knowing (in your court vs with their authors), then lead into the priorities. No 'saw activity' or 'omitted' counts.",
    "- queueSummary.bullets: 2-4 callouts. Lead with the most urgent blocker on your side (tone urgent), then author-side reviews worth a nudge (tone stalled), then quick wins that just need a re-review (tone quick_win). Name the specific pull requests by #number with a short recommendation, but collapse any large group (e.g. stalled drafts) into a count and one characterization instead of listing every #number.",
    "- sinceLastVisit.body: two to three sentences on which way the queue tilted since you last looked; no raw 'N saw activity' count.",
    "- sinceLastVisit.bullets: reviewer-actionable takeaways — which reviews are back in your court and why. Name those pull requests by #number, lead with the consequence, keep counts out of the headline, and do not re-list the stalled #numbers another bullet already covered.",
    hasReference
      ? "- cards: one card only for each pull request needing a fresh read (never for the context-only ones), preserving the listed id. Say what the PR is about and the open point blocking your sign-off; no age/turn-state recitation, no raw counts, no unknown-check nagging."
      : "- cards: one card for each listed pull request, preserving the listed id. Say what the PR is about and the open point blocking your sign-off; no age/turn-state recitation, no raw counts, no unknown-check nagging.",
    "- cards[].machineSummary: a thorough, accurate, self-contained record of the pull request for later reuse — what it changes, where each thread stands, what was decided and why, and the open points. No length limit and no reader styling; it is stored and fed back as context next time, so it must stand on its own without the raw data."
  )

  return { system, user: lines.join("\n") }
}

/** Full prompt for the first generation (every card sent in detail). */
export function buildAiDashboardPrompt(input: AiDashboardInput): {
  system: string
  user: string
} {
  return buildDashboardPrompt({
    metrics: input.metrics,
    fullItems: input.items,
    referenceItems: [],
  })
}

/**
 * Incremental prompt: changed cards in full, unchanged cards as their stored
 * machine summary. The model rewrites the holistic sections and only the
 * full cards.
 */
export function buildIncrementalAiDashboardPrompt(args: {
  metrics: AiDashboardInput["metrics"]
  fullItems: AiDashboardPrInput[]
  referenceItems: DashboardReferenceItem[]
}): { system: string; user: string } {
  return buildDashboardPrompt(args)
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

export function normalizeAiDashboardGeneration(
  value: unknown,
  allowedIds: string[]
): AiDashboardGeneration {
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
  const cards: AiDashboardGeneration["cards"] = []
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
      const machineSummary = text(candidate.machineSummary)
      if (!summary || !sinceYouLooked || !nextAction || !machineSummary) continue
      seen.add(pullRequestId)
      cards.push({
        pullRequestId,
        summary,
        sinceYouLooked,
        nextAction,
        machineSummary,
      })
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
