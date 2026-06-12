/**
 * Prompt builders, JSON schemas, and content normalizers for the AI
 * summaries. Everything here is pure so the exact text sent to OpenRouter —
 * and the cache keys derived from it — stay deterministic and testable.
 *
 * Grounding rule shared by all prompts: the model may only restate what is
 * in the provided data, with file paths and logins it can cite. Summaries
 * never judge, score, or rank; that stays with the deterministic layers.
 */

export interface PrSummaryContent {
  overview: string
  keyChanges: Array<{ file: string; description: string }>
}

export interface PrSummaryFileInput {
  path: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface PrSummaryPromptInput {
  repository: string
  number: number
  title: string
  body?: string
  authorLogin: string
  state: string
  isDraft: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  files: PrSummaryFileInput[]
}

export const prSummarySchemaName = "pr_summary"

export const prSummarySchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "keyChanges"],
  properties: {
    overview: {
      type: "string",
      description:
        "Two to four plain sentences: what the pull request changes and why, grounded in the diff and description.",
    },
    keyChanges: {
      type: "array",
      maxItems: 8,
      description:
        "The most important changes, each tied to a file path from the diff.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "description"],
        properties: {
          file: {
            type: "string",
            description: "A file path exactly as it appears in the diff.",
          },
          description: {
            type: "string",
            description: "One sentence on what changed in that file.",
          },
        },
      },
    },
  },
}

const maxBodyChars = 4_000
const maxPatchCharsPerFile = 3_500
const maxTotalPatchChars = 48_000

export function buildPrSummaryPrompt(input: PrSummaryPromptInput): {
  system: string
  user: string
} {
  const system = [
    "You summarize GitHub pull requests for a reviewer triaging their queue.",
    "Ground every statement in the provided metadata and diff; never invent files, behavior, or intent.",
    "Reference file paths exactly as they appear in the diff.",
    "Be concise and specific. Do not assess risk, quality, or priority.",
  ].join(" ")

  const lines: string[] = [
    `Repository: ${input.repository}`,
    `Pull request #${input.number}: ${input.title}`,
    `Author: ${input.authorLogin}`,
    `State: ${input.state}${input.isDraft ? " (draft)" : ""}`,
  ]
  if (
    input.additions !== undefined ||
    input.deletions !== undefined ||
    input.changedFiles !== undefined
  ) {
    lines.push(
      `Size: +${input.additions ?? "?"} / -${input.deletions ?? "?"} across ${
        input.changedFiles ?? "?"
      } files`
    )
  }

  lines.push(
    "",
    "Description:",
    input.body ? truncateText(input.body, maxBodyChars) : "(none)",
    "",
    "Changed files and patches:"
  )

  let totalPatchChars = 0
  for (const file of input.files) {
    lines.push(
      "",
      `--- ${file.path} (${file.status}, +${file.additions} / -${file.deletions})`
    )
    if (!file.patch) {
      lines.push("(no text patch available)")
      continue
    }

    if (totalPatchChars >= maxTotalPatchChars) {
      lines.push("(patch omitted: diff budget reached)")
      continue
    }

    const patch = truncateText(file.patch, maxPatchCharsPerFile)
    totalPatchChars += patch.length
    lines.push(patch)
  }

  lines.push(
    "",
    "Summarize what this pull request changes. Overview first, then the key changes per file."
  )

  return { system, user: lines.join("\n") }
}

export function normalizePrSummaryContent(value: unknown): PrSummaryContent {
  const parsed = (value ?? {}) as {
    overview?: unknown
    keyChanges?: unknown
  }
  if (typeof parsed.overview !== "string" || parsed.overview.trim() === "") {
    throw new Error("The model response was missing the summary overview.")
  }

  const keyChanges = Array.isArray(parsed.keyChanges)
    ? parsed.keyChanges.flatMap((entry) => {
        const candidate = (entry ?? {}) as {
          file?: unknown
          description?: unknown
        }
        if (
          typeof candidate.file !== "string" ||
          candidate.file.trim() === "" ||
          typeof candidate.description !== "string" ||
          candidate.description.trim() === ""
        ) {
          return []
        }

        return [
          {
            file: candidate.file.trim(),
            description: candidate.description.trim(),
          },
        ]
      })
    : []

  return { overview: parsed.overview.trim(), keyChanges }
}

export interface CatchUpDigestContent {
  narrative: string
  bullets: string[]
}

export interface CatchUpEventInput {
  type: string
  actor: string
  title: string
  body?: string
  occurredAt: string
}

export interface CatchUpDigestPromptInput {
  repository: string
  number: number
  title: string
  lastSeenAt?: string
  events: CatchUpEventInput[]
}

export const catchUpDigestSchemaName = "catch_up_digest"

export const catchUpDigestSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "bullets"],
  properties: {
    narrative: {
      type: "string",
      description:
        "Two to four plain sentences describing what happened on the pull request since the reviewer last caught up.",
    },
    bullets: {
      type: "array",
      maxItems: 6,
      description:
        "The individual highlights worth knowing, most important first.",
      items: { type: "string" },
    },
  },
}

const maxDigestEvents = 50
const maxEventBodyChars = 800

export function buildCatchUpDigestPrompt(input: CatchUpDigestPromptInput): {
  system: string
  user: string
} {
  const system = [
    "You help a code reviewer catch up on a GitHub pull request.",
    "Describe only the activity listed below; never invent events, opinions, or outcomes.",
    "Attribute every statement to the logins provided.",
    "Be brief and concrete. Do not assess risk, quality, or priority.",
  ].join(" ")

  const lines: string[] = [
    `Repository: ${input.repository}`,
    `Pull request #${input.number}: ${input.title}`,
    input.lastSeenAt
      ? `The reviewer last caught up at ${input.lastSeenAt}.`
      : "The reviewer has not caught up on this pull request before.",
    "",
    "Activity since then, oldest first:",
  ]

  const events = input.events.slice(-maxDigestEvents)
  const omitted = input.events.length - events.length
  if (omitted > 0) {
    lines.push(`(${omitted} earlier events omitted)`)
  }

  for (const event of events) {
    lines.push(
      "",
      `- [${event.occurredAt}] ${event.type} by ${event.actor}: ${event.title}`
    )
    if (event.body) {
      lines.push(indentBlock(truncateText(event.body, maxEventBodyChars)))
    }
  }

  lines.push(
    "",
    "Write a short narrative of what happened, then up to six bullet highlights."
  )

  return { system, user: lines.join("\n") }
}

export function normalizeCatchUpDigestContent(
  value: unknown
): CatchUpDigestContent {
  const parsed = (value ?? {}) as { narrative?: unknown; bullets?: unknown }
  if (typeof parsed.narrative !== "string" || parsed.narrative.trim() === "") {
    throw new Error("The model response was missing the digest narrative.")
  }

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .slice(0, 6)
    : []

  return { narrative: parsed.narrative.trim(), bullets }
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }

  return `${text.slice(0, maxChars)}\n(truncated)`
}

export interface ThreadStateContent {
  overall: string
  threadNotes: Array<{ file: string; note: string }>
}

export interface ThreadStateThreadInput {
  filePath?: string
  line?: number
  isResolved: boolean
  isOutdated: boolean
  participants: string[]
  lastActorLogin?: string
  lastActivityAt: string
}

export interface ThreadStateCommentInput {
  actor: string
  body: string
  occurredAt: string
  source?: "issue_comment" | "review_comment" | "review"
  filePath?: string
  line?: number
}

export interface ThreadStatePromptInput {
  repository: string
  number: number
  title: string
  viewerLogin: string
  threads: ThreadStateThreadInput[]
  comments: ThreadStateCommentInput[]
}

export const threadStateSchemaName = "thread_state"

export const threadStateSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["overall", "threadNotes"],
  properties: {
    overall: {
      type: "string",
      description:
        "Two to four plain sentences: what is settled, what is still open, and who is waiting on whom.",
    },
    threadNotes: {
      type: "array",
      maxItems: 10,
      description:
        "One short note per thread you can say something concrete about, keyed by the thread's file path exactly as listed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "note"],
        properties: {
          file: {
            type: "string",
            description: "A thread file path exactly as listed above.",
          },
          note: {
            type: "string",
            description: "One sentence on where that discussion stands.",
          },
        },
      },
    },
  },
}

const maxThreadStateThreads = 30
const maxThreadStateComments = 30
const maxThreadStateBodyChars = 600

export function buildThreadStatePrompt(input: ThreadStatePromptInput): {
  system: string
  user: string
} {
  const system = [
    "You summarize the state of code review discussions on a GitHub pull request.",
    "Use only the threads and comments provided. Never invent file paths, opinions, or agreements.",
    "Attribute a position to a login only when a listed comment states it.",
    "Be brief and concrete. Do not assess code quality, risk, or priority.",
  ].join(" ")

  const lines: string[] = [
    `Repository: ${input.repository}`,
    `Pull request #${input.number}: ${input.title}`,
    `The reviewer reading this summary is ${input.viewerLogin}.`,
    "",
    "Review threads:",
  ]

  for (const thread of input.threads.slice(0, maxThreadStateThreads)) {
    const location = thread.filePath
      ? `${thread.filePath}${thread.line ? `:${thread.line}` : ""}`
      : "(no file recorded)"
    const facts = [
      thread.isResolved ? "resolved" : "unresolved",
      thread.isOutdated ? "outdated by new commits" : undefined,
      `participants: ${thread.participants.join(", ") || "unknown"}`,
      thread.lastActorLogin
        ? `last reply by ${thread.lastActorLogin} at ${thread.lastActivityAt}`
        : `last activity at ${thread.lastActivityAt}`,
    ].filter(Boolean)
    lines.push(`- ${location} — ${facts.join(", ")}`)
  }

  lines.push("", "Recent discussion, oldest first:")
  if (input.comments.length === 0) {
    lines.push("(no comment text cached locally)")
  }
  for (const comment of input.comments.slice(-maxThreadStateComments)) {
    const source = comment.source ? `${comment.source} ` : ""
    const location = comment.filePath
      ? ` on ${comment.filePath}${comment.line ? `:${comment.line}` : ""}`
      : ""
    lines.push(
      "",
      `- [${comment.occurredAt}] ${source}by ${comment.actor}${location}:`,
      indentBlock(truncateText(comment.body, maxThreadStateBodyChars))
    )
  }

  lines.push(
    "",
    "Describe the overall state of the review discussion, then add a short note per thread (keyed by its listed file path) only where you can say something concrete."
  )

  return { system, user: lines.join("\n") }
}

/**
 * Grounding guard: notes are kept only when they cite a file path that is
 * actually one of the pull request's review threads, so a hallucinated path
 * can never render.
 */
export function normalizeThreadStateContent(
  value: unknown,
  allowedFiles: string[]
): ThreadStateContent {
  const parsed = (value ?? {}) as { overall?: unknown; threadNotes?: unknown }
  if (typeof parsed.overall !== "string" || parsed.overall.trim() === "") {
    throw new Error("The model response was missing the thread overview.")
  }

  const allowed = new Set(allowedFiles)
  const threadNotes = Array.isArray(parsed.threadNotes)
    ? parsed.threadNotes.flatMap((entry) => {
        const candidate = (entry ?? {}) as { file?: unknown; note?: unknown }
        if (
          typeof candidate.file !== "string" ||
          typeof candidate.note !== "string" ||
          candidate.note.trim() === "" ||
          !allowed.has(candidate.file.trim())
        ) {
          return []
        }

        return [{ file: candidate.file.trim(), note: candidate.note.trim() }]
      })
    : []

  return { overall: parsed.overall.trim(), threadNotes }
}
