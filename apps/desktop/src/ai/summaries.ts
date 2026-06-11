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
