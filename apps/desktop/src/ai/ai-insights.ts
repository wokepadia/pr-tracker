import type { ReviewerInsightsView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

/**
 * The AI insights generation narrates the deterministic insights — it never
 * re-derives urgency or ranks the queue. The map stage is fully
 * deterministic: each relevant pull request becomes a structured record
 * built from the already-computed insight rows and unseen activity, and one
 * LLM call reduces those records into four short sections (headline,
 * reading order, while-away notes, sweep notes). The model may only
 * reference pull request ids it was given; titles and links render from
 * local data.
 */

export interface AiInsightsPrInput {
  id: string
  repository: string
  number: number
  title: string
  waitingOn: string
  waitingAge: string
  /** Deterministic insight chips, prefixed with their section label. */
  chips: string[]
  /** Unseen activity lines, capped per pull request. */
  unseenEvents: string[]
  /** Recent cached discussion excerpts for AI grounding; not rendered directly. */
  discussionExcerpts?: Array<{
    actor: string
    body: string
    occurredAt: string
    source: "issue_comment" | "review_comment" | "review"
    filePath?: string
    line?: number
  }>
}

export interface AiInsightsInput {
  items: AiInsightsPrInput[]
  omittedCount: number
}

export interface AiInsightsContent {
  headline: string
  readingOrder: Array<{ pullRequestId: string; why: string }>
  whileAway: Array<{ pullRequestId: string; note: string }>
  sweep: Array<{ pullRequestId: string; note: string }>
}

const maxInputItems = 40
const maxUnseenEventsPerItem = 5
const maxDiscussionExcerptsPerItem = 5
const maxDiscussionExcerptChars = 500
const maxReadingOrderEntries = 8
const maxWhileAwayEntries = 6
const maxSweepEntries = 4
const sectionLabels: Array<{
  key: "needsYouNow" | "mightBeMissing" | "whileAway" | "hygiene"
  label: string
}> = [
  { key: "needsYouNow", label: "needs you now" },
  { key: "mightBeMissing", label: "might be missing" },
  { key: "whileAway", label: "finished while away" },
  { key: "hygiene", label: "aging" },
]

/**
 * Builds the deterministic rollup input. The items array is the scope
 * universe — callers pass board-scoped items only, and insight rows
 * referencing pull requests outside it are dropped, so nothing off the
 * user's board ever reaches the prompt. Ordering is deliberate: long-input
 * summarization is most faithful at the edges of the input, so the
 * needs-you-now items lead and the might-be-missing contradictions close,
 * with lower-stakes rows in the middle.
 */
export function buildAiInsightsInput(
  insights: ReviewerInsightsView,
  items: ReviewQueueItemView[]
): AiInsightsInput {
  const recordById = new Map<string, AiInsightsPrInput>()
  const itemById = new Map(items.map((item) => [item.id, item]))

  const record = (item: ReviewQueueItemView): AiInsightsPrInput => {
    const existing = recordById.get(item.id)
    if (existing) return existing

    const created: AiInsightsPrInput = {
      id: item.id,
      repository: item.repository,
      number: item.number,
      title: item.title,
      waitingOn: item.waitingOn,
      waitingAge: item.waitingAge,
      chips: [],
      unseenEvents: item.activityEvents
        .filter((event) => event.isNew)
        .slice(0, maxUnseenEventsPerItem)
        .map((event) => `${event.actor} ${event.action}`),
    }
    recordById.set(item.id, created)
    return created
  }

  for (const section of sectionLabels) {
    for (const row of insights[section.key]) {
      const item = itemById.get(row.item.id)
      if (!item) continue
      record(item).chips.push(`${section.label}: ${row.whyChip}`)
    }
  }

  // Pull requests with unseen activity but no insight row still matter for
  // the while-away section.
  for (const item of items) {
    if (item.unseenEventCount > 0 && !recordById.has(item.id)) {
      record(item)
    }
  }

  const bySection = (key: (typeof sectionLabels)[number]["key"]) =>
    insights[key].flatMap((row) => {
      const found = recordById.get(row.item.id)
      return found ? [found] : []
    })
  const inSections = new Set(
    sectionLabels.flatMap((section) =>
      insights[section.key].map((row) => row.item.id)
    )
  )
  const unseenOnly = [...recordById.values()].filter(
    (entry) => !inSections.has(entry.id)
  )

  const ordered = dedupeById([
    ...bySection("needsYouNow"),
    ...bySection("hygiene"),
    ...unseenOnly,
    ...bySection("whileAway"),
    ...bySection("mightBeMissing"),
  ])
  // Over the cap, keep the edges (the most important rows live there).
  const within =
    ordered.length <= maxInputItems
      ? ordered
      : [...ordered.slice(0, maxInputItems - 10), ...ordered.slice(-10)]

  return {
    items: within,
    omittedCount: ordered.length - within.length,
  }
}

function dedupeById(entries: AiInsightsPrInput[]): AiInsightsPrInput[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}

export const aiInsightsSchemaName = "ai_insights"

export const aiInsightsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "readingOrder", "whileAway", "sweep"],
  properties: {
    headline: {
      type: "string",
      description:
        "One or two plain sentences: the single most useful takeaway about the queue right now.",
    },
    readingOrder: {
      type: "array",
      maxItems: maxReadingOrderEntries,
      description:
        "A suggested reading order over the pull requests waiting on the reviewer, most pressing first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequestId", "why"],
        properties: {
          pullRequestId: {
            type: "string",
            description: "A pull request id exactly as listed.",
          },
          why: {
            type: "string",
            description:
              "One concrete sentence drawn from the listed facts.",
          },
        },
      },
    },
    whileAway: {
      type: "array",
      maxItems: maxWhileAwayEntries,
      description:
        "Short notes on what concluded or changed without the reviewer.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequestId", "note"],
        properties: {
          pullRequestId: {
            type: "string",
            description: "A pull request id exactly as listed.",
          },
          note: { type: "string" },
        },
      },
    },
    sweep: {
      type: "array",
      maxItems: maxSweepEntries,
      description:
        "Short notes grouping the pull requests with aging flags — restate the listed facts only, never advice about code or people.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequestId", "note"],
        properties: {
          pullRequestId: {
            type: "string",
            description: "A pull request id exactly as listed.",
          },
          note: { type: "string" },
        },
      },
    },
  },
}

export function buildAiInsightsPrompt(input: AiInsightsInput): {
  system: string
  user: string
} {
  const system = [
    "You write a short triage brief for a code reviewer's pull request queue.",
    "Use only the pull requests and facts listed; never invent pull requests, events, or opinions.",
    "The deterministic facts (who owes a reply, for how long, which flags fired) are authoritative — restate them, never re-judge them.",
    "Reference pull requests by their listed id in the structured fields.",
    "Be brief and concrete. Do not assess code quality, risk, or the reviewer's performance.",
  ].join(" ")

  // No raw timestamps here: the visit anchor advances every session even
  // when the queue is unchanged, and embedding it made cached briefs go
  // stale on every visit. The away window is already baked into the rows.
  const lines: string[] = [
    "The reviewer's queue, as computed deterministically:",
    "",
  ]

  for (const item of input.items) {
    lines.push(
      `- id ${item.id} | ${item.repository}#${item.number} | ${item.title}`,
      `  waiting on: ${item.waitingOn}${
        item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
      }`
    )
    for (const chip of item.chips) {
      lines.push(`  flag — ${chip}`)
    }
    if (item.unseenEvents.length > 0) {
      lines.push(`  new since last seen: ${item.unseenEvents.join("; ")}`)
    }
    for (const excerpt of (item.discussionExcerpts ?? []).slice(
      -maxDiscussionExcerptsPerItem
    )) {
      const location = excerpt.filePath
        ? ` on ${excerpt.filePath}${excerpt.line ? `:${excerpt.line}` : ""}`
        : ""
      lines.push(
        `  discussion — [${excerpt.occurredAt}] ${excerpt.source}${location} by ${excerpt.actor}:`,
        indentBlock(truncateText(excerpt.body, maxDiscussionExcerptChars))
      )
    }
  }

  if (input.omittedCount > 0) {
    lines.push("", `(${input.omittedCount} lower-priority pull requests omitted)`)
  }

  lines.push(
    "",
    "Write the headline, then the needs-you reading order, then the while-away notes, then sweep notes grouping the pull requests with aging flags. Only reference listed ids; leave a list empty when nothing fits it."
  )

  return { system, user: lines.join("\n") }
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

/**
 * Grounding guard: entries survive only when their pull request id was part
 * of the rollup input, so the sections can never point at a pull request
 * the app cannot link. Duplicate ids keep their first entry.
 */
export function normalizeAiInsightsContent(
  value: unknown,
  allowedIds: string[]
): AiInsightsContent {
  const parsed = (value ?? {}) as {
    headline?: unknown
    readingOrder?: unknown
    whileAway?: unknown
    sweep?: unknown
  }
  if (typeof parsed.headline !== "string" || parsed.headline.trim() === "") {
    throw new Error("The model response was missing the insights headline.")
  }

  const allowed = new Set(allowedIds)
  const pick = (
    entries: unknown,
    textField: "why" | "note",
    cap: number
  ): Array<{ pullRequestId: string; text: string }> => {
    if (!Array.isArray(entries)) return []
    const seen = new Set<string>()
    const result: Array<{ pullRequestId: string; text: string }> = []
    for (const entry of entries) {
      const candidate = (entry ?? {}) as Record<string, unknown>
      const id =
        typeof candidate.pullRequestId === "string"
          ? candidate.pullRequestId.trim()
          : ""
      const text =
        typeof candidate[textField] === "string"
          ? (candidate[textField] as string).trim()
          : ""
      if (!id || !text || !allowed.has(id) || seen.has(id)) continue
      seen.add(id)
      result.push({ pullRequestId: id, text })
      if (result.length >= cap) break
    }
    return result
  }

  return {
    headline: parsed.headline.trim(),
    readingOrder: pick(parsed.readingOrder, "why", maxReadingOrderEntries).map(
      (entry) => ({
        pullRequestId: entry.pullRequestId,
        why: entry.text,
      })
    ),
    whileAway: pick(parsed.whileAway, "note", maxWhileAwayEntries).map(
      (entry) => ({
        pullRequestId: entry.pullRequestId,
        note: entry.text,
      })
    ),
    sweep: pick(parsed.sweep, "note", maxSweepEntries).map((entry) => ({
      pullRequestId: entry.pullRequestId,
      note: entry.text,
    })),
  }
}
