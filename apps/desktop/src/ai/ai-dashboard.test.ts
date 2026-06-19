import { describe, expect, it } from "vitest"

import type { ReviewQueueItemView } from "@/reviewer/view-model"
import {
  buildAiDashboardInput,
  buildAiDashboardPrompt,
  normalizeAiDashboardContent,
} from "./ai-dashboard"

function makeItem(
  overrides: Partial<ReviewQueueItemView> & { id: string }
): ReviewQueueItemView {
  return {
    repository: "acme/api",
    number: 1,
    title: `Title ${overrides.id}`,
    description: "Updates the review flow.",
    authorLogin: "maya",
    waitingOn: "you",
    waitingAge: "4d",
    state: "open",
    workflowState: "needs_review",
    unansweredReviewRequest: false,
    waitingUrgency: "overdue",
    updatedAt: "2h ago",
    updatedAtIso: "2026-06-11T10:00:00.000Z",
    openedAt: "3d ago",
    reason: "You are requested as a reviewer.",
    labels: [],
    assignees: [],
    otherReviewers: [],
    userLastReviewDecision: "pending",
    approvalStale: false,
    unseenEventCount: 0,
    newCommitCount: 0,
    newReplyCount: 0,
    unresolvedThreadCount: 0,
    totalThreadCount: 0,
    reviewRounds: 0,
    reviewThreads: [],
    activityEvents: [],
    ...overrides,
  } as ReviewQueueItemView
}

describe("buildAiDashboardInput", () => {
  it("keeps only the board-scoped open review universe and computes metrics", () => {
    const urgent = makeItem({ id: "pr_urgent" })
    const waiting = makeItem({
      id: "pr_waiting",
      waitingOn: "author",
      waitingUrgency: "none",
      workflowState: "waiting_on_author",
    })
    const closed = makeItem({ id: "pr_closed", state: "merged" })

    const input = buildAiDashboardInput([urgent, waiting, closed], {
      sinceVisitLabel: "2h ago",
    })

    expect(input.items.map((item) => item.id)).toEqual([
      "pr_urgent",
      "pr_waiting",
    ])
    expect(input.metrics.openReviewCount).toBe(2)
    expect(input.metrics.yourMoveCount).toBe(1)
    expect(input.metrics.waitingOnAuthorCount).toBe(1)
    expect(input.metrics.stalledCount).toBe(1)
    expect(input.metrics.sinceVisitLabel).toBe("2h ago")
    expect(input.items[0]?.isStalled).toBe(true)
  })

  it("orders reviewer-owned work first and caps long queues", () => {
    const yourMove = Array.from({ length: 32 }, (_value, index) =>
      makeItem({ id: `pr_you_${index}` })
    )
    const waiting = makeItem({
      id: "pr_author",
      waitingOn: "author",
      waitingUrgency: "none",
      workflowState: "waiting_on_author",
    })

    const input = buildAiDashboardInput([waiting, ...yourMove])

    expect(input.items).toHaveLength(30)
    expect(input.items[0]?.id).toBe("pr_you_0")
    expect(input.metrics.omittedCount).toBe(3)
  })

  it("surfaces diff size, since-last-review deltas, and awaiting-reply counts", () => {
    const item = makeItem({
      id: "pr_rich",
      size: { bucket: "M", lineCount: 331, additions: 265, deletions: 66, fileCount: 9 },
      newReplyCount: 3,
      unresolvedThreadCount: 2,
      totalThreadCount: 4,
      otherReviewers: [{ login: "priya", decision: "approved" }],
      sinceLastReview: {
        decision: "changes_requested",
        reviewedAt: "3d ago",
        commits: [
          { id: "c1", title: "fix", occurredAt: "1d ago" },
          { id: "c2", title: "more", occurredAt: "1d ago" },
        ],
        replyCount: 2,
        threadsResolvedCount: 2,
      },
      reviewThreads: [
        {
          id: "t1",
          author: "maya",
          status: "unresolved",
          authorReplied: true,
          excerpt: "src/auth.ts:44",
          awaitingYourReply: true,
          isOutdated: false,
          lastActorLogin: "maya",
        },
      ] as ReviewQueueItemView["reviewThreads"],
    })

    const input = buildAiDashboardInput([item])
    const promptItem = input.items[0]
    if (!promptItem) throw new Error("Expected dashboard input item.")

    expect(promptItem.additions).toBe(265)
    expect(promptItem.deletions).toBe(66)
    expect(promptItem.awaitingYourReplyCount).toBe(1)
    expect(promptItem.sinceLastReview?.commitCount).toBe(2)
    expect(promptItem.sinceLastReview?.threadsResolvedCount).toBe(2)
    expect(promptItem.otherReviewers).toEqual([
      { login: "priya", decision: "approved" },
    ])
  })
})

describe("buildAiDashboardPrompt", () => {
  it("lists metrics, diff facts, reviewers, unseen activity, and excerpts", () => {
    const item = makeItem({
      id: "pr_1",
      repository: "acme/api",
      number: 142,
      title: "Normalize webhooks",
      labels: [{ name: "backend" }],
      size: { bucket: "M", lineCount: 90, additions: 64, deletions: 26, fileCount: 3 },
      newCommitCount: 2,
      newReplyCount: 1,
      unresolvedThreadCount: 1,
      totalThreadCount: 3,
      checks: { state: "failure", totalCount: 1 },
      otherReviewers: [{ login: "lin", decision: "pending" }],
      activityEvents: [
        {
          actor: "maya",
          action: "pushed 2 commits",
          isNew: true,
        },
      ] as ReviewQueueItemView["activityEvents"],
    })
    const input = buildAiDashboardInput([item], { sinceVisitLabel: "2h ago" })
    const promptItem = input.items[0]
    if (!promptItem) throw new Error("Expected dashboard input item.")
    promptItem.discussionExcerpts = [
      {
        actor: "maya",
        body: "The webhook retry state now matches the queue transition.",
        occurredAt: "2026-06-10T09:00:00.000Z",
        source: "review_comment",
        filePath: "src/webhooks.ts",
        line: 44,
      },
    ]

    const { system, user } = buildAiDashboardPrompt(input)

    expect(system).toContain("reviewer's queue brief")
    expect(system).toContain("Do not declare code correct or incorrect")
    expect(system).toContain("never enumerate a long list of pull-request numbers")
    expect(user).toContain("reviewer-actionable takeaways")
    expect(user).toContain("- open reviews: 1")
    expect(user).toContain("- reviewer last visited: 2h ago")
    expect(user).toContain("- id pr_1 | acme/api#142 | Normalize webhooks")
    expect(user).toContain("+64 -26")
    expect(user).toContain("2 new commits")
    expect(user).toContain("checks: failure")
    expect(user).toContain("other reviewers: lin pending")
    expect(user).toContain("labels: backend")
    expect(user).toContain("since you last looked: maya pushed 2 commits")
    expect(user).toContain(
      "discussion - [2026-06-10T09:00:00.000Z] review_comment on src/webhooks.ts:44 by maya:"
    )
  })
})

describe("normalizeAiDashboardContent", () => {
  it("normalizes summaries and drops cards for unknown or duplicate ids", () => {
    expect(
      normalizeAiDashboardContent(
        {
          queueSummary: {
            body: " Two reviews need you. ",
            bullets: [
              { tone: "urgent", text: " Start with #1. " },
              { tone: "unknown", text: " Plain note. " },
            ],
          },
          sinceLastVisit: {
            body: " One review moved. ",
            bullets: [" Maya pushed commits. "],
          },
          cards: [
            {
              pullRequestId: "pr_1",
              summary: " Open 3 days. ",
              sinceYouLooked: " Maya replied. ",
              nextAction: " Re-review. ",
            },
            {
              pullRequestId: "pr_1",
              summary: " duplicate ",
              sinceYouLooked: " duplicate ",
              nextAction: " duplicate ",
            },
            {
              pullRequestId: "pr_invented",
              summary: " invented ",
              sinceYouLooked: " invented ",
              nextAction: " invented ",
            },
          ],
        },
        ["pr_1"]
      )
    ).toEqual({
      queueSummary: {
        body: "Two reviews need you.",
        bullets: [
          { tone: "urgent", text: "Start with #1." },
          { tone: "info", text: "Plain note." },
        ],
      },
      sinceLastVisit: {
        body: "One review moved.",
        bullets: ["Maya pushed commits."],
      },
      cards: [
        {
          pullRequestId: "pr_1",
          summary: "Open 3 days.",
          sinceYouLooked: "Maya replied.",
          nextAction: "Re-review.",
        },
      ],
    })
  })

  it("throws when required text blocks are missing", () => {
    expect(() => normalizeAiDashboardContent({}, [])).toThrow(
      "The model response was missing the queue summary."
    )
  })
})
