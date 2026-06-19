import type { AiDashboardInput } from "@/ai/ai-dashboard"

/**
 * Builds the grounding for the dashboard chat. The chat answers questions about
 * the reviewer's pull requests using ONLY the applied board's data — the same
 * board-scoped projection the dashboard renders. The board context is rendered
 * into the system prompt and the model is told to refuse anything outside it,
 * so the chat physically cannot reference an off-board pull request and is
 * instructed not to invent facts.
 */

const maxDiscussionExcerptsPerItem = 5
const maxDiscussionExcerptChars = 400
const maxDescriptionChars = 300

export const chatGroundingRules: string[] = [
  "You are a review assistant embedded in a pull-request review dashboard.",
  "Answer ONLY from the board pull requests and facts provided below. They are the reviewer's entire responsibility scope; treat anything not listed as outside your knowledge.",
  "If the answer is not supported by the provided data, say you don't have that information for the current board — do not guess, and do not use any outside knowledge about these repositories.",
  "Never invent pull requests, people, numbers, statuses, commits, or events. Never reference a pull request that is not listed.",
  "When you reference a pull request, use its repository and #number so the reviewer can find it.",
  "Be concise and direct, and address the reviewer as 'you'. The deterministic waiting side (your court vs the author's) is authoritative.",
]

/** Renders the board-scoped pull requests into a compact, factual context
 * block. Mirrors the dashboard's input so the chat sees exactly the board. */
export function buildChatBoardContext(input: AiDashboardInput): string {
  const lines: string[] = [
    "Board-scoped review queue:",
    `- open reviews: ${input.metrics.openReviewCount}`,
    `- in your court: ${input.metrics.yourMoveCount}`,
    `- with their authors: ${input.metrics.waitingOnAuthorCount}`,
    `- stalled: ${input.metrics.stalledCount}`,
  ]
  if (input.metrics.sinceVisitLabel) {
    lines.push(`- you last visited: ${input.metrics.sinceVisitLabel}`)
  }
  if (input.metrics.omittedCount > 0) {
    lines.push(
      `- note: ${input.metrics.omittedCount} lower-priority board pull request(s) are not detailed below.`
    )
  }

  if (input.items.length === 0) {
    lines.push("", "There are no open pull requests on the board right now.")
    return lines.join("\n")
  }

  lines.push("", "Pull requests on the board:")
  for (const item of input.items) {
    lines.push(
      `- ${item.repository}#${item.number} — ${item.title}`,
      `  author: ${item.authorLogin}; state: ${item.state}`,
      `  waiting on: ${item.waitingOn}${
        item.waitingOn === "none" ? "" : ` for ${item.waitingAge}`
      } (urgency ${item.waitingUrgency}${item.isStalled ? ", stalled" : ""})`,
      `  opened: ${item.openedAt}; last active: ${item.updatedAt}`,
      `  why it's here: ${item.reason}`
    )
    if (item.description) {
      lines.push(`  description: ${truncate(item.description, maxDescriptionChars)}`)
    }
    lines.push(
      `  your last review: ${item.userLastReviewDecision}${
        item.approvalStale ? " (stale — branch moved after you approved)" : ""
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
      `  size: ${formatDiff(item.additions, item.deletions)} across ${
        item.fileCount ?? "unknown"
      } files; ${item.newCommitCount} new commit(s) and ${
        item.newReplyCount
      } new reply(ies) since you looked; ${item.unresolvedThreadCount}/${
        item.totalThreadCount
      } unresolved threads (${item.awaitingYourReplyCount} awaiting your reply); ${
        item.reviewRounds
      } changes-requested round(s)`
    )
    if (item.checksState) {
      lines.push(`  checks: ${item.checksState}`)
    }
    if (item.labels.length > 0) {
      lines.push(`  labels: ${item.labels.join(", ")}`)
    }
    for (const event of item.unseenEvents) {
      lines.push(`  since you last looked: ${event}`)
    }
    for (const thread of item.unresolvedThreads) {
      lines.push(
        `  unresolved thread: ${thread.excerpt}; last actor ${
          thread.lastActorLogin ?? "unknown"
        }; ${
          thread.awaitingYourReply ? "awaiting your reply" : "awaiting author reply"
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
        `  comment [${excerpt.occurredAt}] ${excerpt.source}${location} by ${excerpt.actor}: ${truncate(
          excerpt.body,
          maxDiscussionExcerptChars
        )}`
      )
    }
  }

  return lines.join("\n")
}

export function buildChatSystemPrompt(input: AiDashboardInput): string {
  return [
    chatGroundingRules.join(" "),
    "",
    buildChatBoardContext(input),
  ].join("\n")
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
