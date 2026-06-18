/**
 * Prompt builder, JSON schema, and normalizer for the consolidated PR brief —
 * the single AI generation behind the pull request detail view. One call
 * produces every AI section the detail page renders: why it is the reviewer's
 * turn, what the pull request does, where the conversation stands, what moved
 * since the reviewer last looked, and what to do next.
 *
 * Everything here is pure so the exact text sent to the provider — and the
 * cache key derived from it — stays deterministic and testable.
 *
 * Grounding rule shared by every field: the model may only restate the facts
 * provided below. It narrates review flow (whose turn, what changed, what is
 * next); it never assesses code quality, correctness, risk, or priority, and
 * never invents pull requests, events, files, people, or numbers. The
 * deterministic waiting side and counts are authoritative.
 */

export type PrBriefChangeTag =
  | "new"
  | "refactor"
  | "fix"
  | "test"
  | "docs"
  | "chore"

export type PrBriefSinceKind =
  | "commit"
  | "comment"
  | "review"
  | "thread"
  | "check"
  | "other"

export interface PrBriefContent {
  /** Why it is the reviewer's (or author's) turn right now — the "Your move"
   * narrative. */
  yourMove: string
  whatThisDoes: {
    overview: string
    changes: Array<{ tag: PrBriefChangeTag; text: string }>
  }
  conversation: {
    overview: string
    /** One note per review thread, keyed by the thread's file path exactly as
     * listed. Notes for unknown paths are dropped by the normalizer. */
    threads: Array<{ file: string; note: string }>
  }
  /** What moved since the reviewer last looked, newest-relevant first. */
  sinceYouLooked: Array<{
    kind: PrBriefSinceKind
    text: string
    detail?: string
  }>
  /** Concrete ordered next steps for the reviewer. */
  whatsNext: string[]
}

export interface PrBriefFileInput {
  path: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface PrBriefThreadInput {
  filePath?: string
  line?: number
  status: "resolved" | "unresolved"
  awaitingYourReply: boolean
  isOutdated: boolean
  lastActorLogin?: string
  participants: string[]
}

export interface PrBriefCommentInput {
  actor: string
  body: string
  occurredAt: string
  source: "issue_comment" | "review_comment" | "review"
  filePath?: string
  line?: number
}

export interface PrBriefEventInput {
  type: string
  actor: string
  title: string
  body?: string
  occurredAt: string
}

export interface PrBriefReviewerInput {
  login: string
  decision: string
}

export interface PrBriefPromptInput {
  repository: string
  number: number
  title: string
  body?: string
  authorLogin: string
  viewerLogin: string
  state: string
  isDraft: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  waitingOn: string
  waitingAge: string
  waitingUrgency: string
  isStalled: boolean
  reason: string
  userLastReviewDecision: string
  approvalStale: boolean
  reviewRounds: number
  checksState?: string
  lastSeenLabel?: string
  otherReviewers: PrBriefReviewerInput[]
  newEvents: PrBriefEventInput[]
  threads: PrBriefThreadInput[]
  comments: PrBriefCommentInput[]
  files: PrBriefFileInput[]
}

export const prBriefSchemaName = "pr_brief"

const changeTags: PrBriefChangeTag[] = [
  "new",
  "refactor",
  "fix",
  "test",
  "docs",
  "chore",
]

const sinceKinds: PrBriefSinceKind[] = [
  "commit",
  "comment",
  "review",
  "thread",
  "check",
  "other",
]

const maxChanges = 8
const maxThreadNotes = 12
const maxSinceItems = 5
const maxNextSteps = 6

export const prBriefSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "yourMove",
    "whatThisDoes",
    "conversation",
    "sinceYouLooked",
    "whatsNext",
  ],
  properties: {
    yourMove: {
      type: "string",
      description:
        "Three to five sentences, addressed to the reviewer as 'you', explaining whose turn it is and why: what the author did most recently, what is still pending, and — when stalled — why it has waited. Give enough context that the reviewer understands the situation without reopening GitHub. Review flow only.",
    },
    whatThisDoes: {
      type: "object",
      additionalProperties: false,
      required: ["overview", "changes"],
      properties: {
        overview: {
          type: "string",
          description:
            "Three to four plain sentences on what the pull request changes and why, grounded in the diff and description — cover the overall approach and the main areas it touches, not just a one-line gist.",
        },
        changes: {
          type: "array",
          maxItems: maxChanges,
          description:
            "The most important changes, each tagged by the kind of change.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tag", "text"],
            properties: {
              tag: { type: "string", enum: changeTags },
              text: {
                type: "string",
                description:
                  "One or two sentences on that change — what it does and why it matters — citing a file path from the diff where it helps.",
              },
            },
          },
        },
      },
    },
    conversation: {
      type: "object",
      additionalProperties: false,
      required: ["overview", "threads"],
      properties: {
        overview: {
          type: "string",
          description:
            "Three to five sentences: how many threads there are, what is settled, what is still open, and who is waiting on whom. Empty string when there are no threads.",
        },
        threads: {
          type: "array",
          maxItems: maxThreadNotes,
          description:
            "One short note per review thread you can say something concrete about, keyed by the thread's location exactly as listed.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["file", "note"],
            properties: {
              file: {
                type: "string",
                description: "A thread location exactly as listed above.",
              },
              note: {
                type: "string",
                description:
                  "One or two sentences on where that discussion stands and what it would take to resolve it.",
              },
            },
          },
        },
      },
    },
    sinceYouLooked: {
      type: "array",
      maxItems: maxSinceItems,
      description:
        "What changed since the reviewer last looked that affects their review decision — synthesized into a few takeaways, not a transcript. Group related events; omit anything that did not change (never a zero or a 'no new commits'). Empty array when nothing material moved.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: sinceKinds },
          text: {
            type: "string",
            description:
              "One or two sentences, led by the consequence for your review (e.g. \"Your change requests aren't in the code yet — the author replied in discussion instead\") and then the context behind it. Name the actors; never headline a raw count.",
          },
          detail: {
            type: "string",
            description:
              "Optional supporting evidence behind the takeaway — the specific thread, file, or count (e.g. \"dropdown-behavior thread, now 21 replies, still unresolved\").",
          },
        },
      },
    },
    whatsNext: {
      type: "array",
      maxItems: maxNextSteps,
      description:
        "Concrete next steps in the order the reviewer should take them, each a full sentence with enough specifics to act on, grounded in the waiting side and listed facts.",
      items: { type: "string" },
    },
  },
}

/**
 * The stable key for a review thread, shared by the prompt's thread list, the
 * normalizer's grounding guard, and the detail view's note overlay so an AI
 * note always lines up with the thread it describes. Matches the view-model's
 * thread excerpt for file-backed threads.
 */
export function threadLocationKey(filePath?: string, line?: number): string {
  if (!filePath) return "(no file recorded)"
  return line ? `${filePath}:${line}` : filePath
}

const maxBodyChars = 4_000
const maxPatchCharsPerFile = 3_500
const maxTotalPatchChars = 48_000
const maxThreads = 30
const maxComments = 30
const maxCommentBodyChars = 600
const maxEvents = 40
const maxEventBodyChars = 600

export function buildPrBriefPrompt(input: PrBriefPromptInput): {
  system: string
  user: string
} {
  const system = [
    "You write a turn-tracking brief for a code reviewer reading one GitHub pull request.",
    "Use only the metadata, diff, threads, comments, and events provided; never invent files, behavior, events, people, or numbers.",
    "Reference file paths exactly as they appear in the diff or thread list.",
    "Write in a direct, concrete, second-person voice addressed to the reviewer ('you'), naming the actors who acted.",
    "Explain whose turn it is and why, what the pull request does, where the discussion stands, what moved since the reviewer last looked, and exactly what to do next.",
    "When you report what moved, lead with what it means for the reviewer's decision — whether the author addressed their change requests, whether the ball is back in their court, whether anything invalidated their prior review — never replay the raw event log or headline a count.",
    "The deterministic waiting side, counts, and check state are authoritative; never contradict them.",
    "Do not assess code quality, correctness, implementation risk, or priority.",
  ].join(" ")

  const lines: string[] = [
    `Repository: ${input.repository}`,
    `Pull request #${input.number}: ${input.title}`,
    `Author: ${input.authorLogin}`,
    `The reviewer reading this brief is ${input.viewerLogin}.`,
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
    `Waiting on: ${input.waitingOn}${
      input.waitingOn === "none" ? "" : ` for ${input.waitingAge}`
    } (urgency ${input.waitingUrgency}${input.isStalled ? ", stalled" : ""})`,
    `Deterministic reason: ${input.reason}`,
    `Reviewer's last review: ${input.userLastReviewDecision}${
      input.approvalStale ? " (now stale — branch moved after the approval)" : ""
    }`,
    `Changes-requested rounds so far: ${input.reviewRounds}`,
    `Head-commit checks: ${input.checksState ?? "unknown"}`,
    `Reviewer last looked: ${input.lastSeenLabel ?? "never"}`
  )
  if (input.otherReviewers.length > 0) {
    lines.push(
      `Other reviewers: ${input.otherReviewers
        .map((reviewer) => `${reviewer.login} ${reviewer.decision}`)
        .join(", ")}`
    )
  }

  lines.push("", "Description:", input.body ? truncateText(input.body, maxBodyChars) : "(none)")

  lines.push("", "Activity since the reviewer last looked, oldest first:")
  const events = input.newEvents.slice(-maxEvents)
  if (events.length === 0) {
    lines.push("(nothing new since the reviewer last looked)")
  }
  for (const event of events) {
    lines.push(`- [${event.occurredAt}] ${event.type} by ${event.actor}: ${event.title}`)
    if (event.body) {
      lines.push(indentBlock(truncateText(event.body, maxEventBodyChars)))
    }
  }

  lines.push("", "Review threads:")
  if (input.threads.length === 0) {
    lines.push("(no review threads)")
  }
  for (const thread of input.threads.slice(0, maxThreads)) {
    const location = threadLocationKey(thread.filePath, thread.line)
    const facts = [
      thread.status,
      thread.awaitingYourReply ? "awaiting your reply" : "awaiting author reply",
      thread.isOutdated ? "outdated by new commits" : undefined,
      `participants: ${thread.participants.join(", ") || "unknown"}`,
      thread.lastActorLogin ? `last reply by ${thread.lastActorLogin}` : undefined,
    ].filter(Boolean)
    lines.push(`- ${location} — ${facts.join(", ")}`)
  }

  lines.push("", "Recent discussion, oldest first:")
  if (input.comments.length === 0) {
    lines.push("(no comment text cached locally)")
  }
  for (const comment of input.comments.slice(-maxComments)) {
    const location = comment.filePath
      ? ` on ${comment.filePath}${comment.line ? `:${comment.line}` : ""}`
      : ""
    lines.push(
      `- [${comment.occurredAt}] ${comment.source}${location} by ${comment.actor}:`,
      indentBlock(truncateText(comment.body, maxCommentBodyChars))
    )
  }

  lines.push("", "Changed files and patches:")
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
    "Write the brief fields:",
    "- yourMove: why it is your turn (or the author's) right now, citing the most recent author action and what still blocks merge.",
    "- whatThisDoes: an overview plus the key changes, each tagged new/refactor/fix/test/docs/chore.",
    "- conversation: an overview of where the threads stand, plus one note per thread keyed by its listed location where you can say something concrete.",
    "- sinceYouLooked: a few synthesized takeaways about what changed that affects your decision — did the author address your change requests in code or only in discussion, is the ball back in your court, did new commits invalidate your prior review. Group related events, lead with the implication, and put any count in the optional detail, never as the message; omit unchanged facts entirely.",
    "- whatsNext: the concrete steps to take, in order, to move this toward merge."
  )

  return { system, user: lines.join("\n") }
}

/**
 * Grounding guard: thread notes survive only when they cite a file path that
 * is actually one of the pull request's review threads, so a hallucinated path
 * can never render.
 */
export function normalizePrBriefContent(
  value: unknown,
  allowedThreadFiles: string[]
): PrBriefContent {
  const parsed = (value ?? {}) as Record<string, unknown>

  const yourMove = text(parsed.yourMove)
  if (!yourMove) {
    throw new Error("The model response was missing the your-move narrative.")
  }

  const whatThisDoesRaw = (parsed.whatThisDoes ?? {}) as Record<string, unknown>
  const overview = text(whatThisDoesRaw.overview)
  if (!overview) {
    throw new Error("The model response was missing the change overview.")
  }
  const changes = Array.isArray(whatThisDoesRaw.changes)
    ? whatThisDoesRaw.changes.flatMap((entry) => {
        const candidate = (entry ?? {}) as Record<string, unknown>
        const value = text(candidate.text)
        if (!value) return []
        const tag = changeTags.includes(candidate.tag as PrBriefChangeTag)
          ? (candidate.tag as PrBriefChangeTag)
          : "chore"
        return [{ tag, text: value }]
      })
    : []

  const conversationRaw = (parsed.conversation ?? {}) as Record<string, unknown>
  const allowed = new Set(allowedThreadFiles)
  const seenThreadFiles = new Set<string>()
  const threads = Array.isArray(conversationRaw.threads)
    ? conversationRaw.threads.flatMap((entry) => {
        const candidate = (entry ?? {}) as Record<string, unknown>
        const file = text(candidate.file)
        const note = text(candidate.note)
        if (
          !file ||
          !note ||
          !allowed.has(file) ||
          seenThreadFiles.has(file)
        ) {
          return []
        }
        seenThreadFiles.add(file)
        return [{ file, note }]
      })
    : []

  const sinceYouLooked = Array.isArray(parsed.sinceYouLooked)
    ? parsed.sinceYouLooked
        .flatMap((entry) => {
          const candidate = (entry ?? {}) as Record<string, unknown>
          const value = text(candidate.text)
          if (!value) return []
          const kind = sinceKinds.includes(candidate.kind as PrBriefSinceKind)
            ? (candidate.kind as PrBriefSinceKind)
            : "other"
          const detail = text(candidate.detail)
          return [detail ? { kind, text: value, detail } : { kind, text: value }]
        })
        .slice(0, maxSinceItems)
    : []

  const whatsNext = Array.isArray(parsed.whatsNext)
    ? parsed.whatsNext
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .slice(0, maxNextSteps)
    : []

  return {
    yourMove,
    whatThisDoes: { overview, changes: changes.slice(0, maxChanges) },
    conversation: {
      overview: text(conversationRaw.overview),
      threads: threads.slice(0, maxThreadNotes),
    },
    sinceYouLooked,
    whatsNext,
  }
}

function indentBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n(truncated)`
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
