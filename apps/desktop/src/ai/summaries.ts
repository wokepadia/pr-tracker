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

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }

  return `${text.slice(0, maxChars)}\n(truncated)`
}
