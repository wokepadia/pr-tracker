import { describe, expect, it } from "vitest"

import type { ReviewerInsightsView, InsightRowView } from "@/reviewer/insights"
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
    waitingUrgency: "overdue",
    updatedAt: "2h ago",
    updatedAtIso: "2026-06-11T10:00:00.000Z",
    openedAt: "3d ago",
    reason: "You are requested as a reviewer.",
    labels: [],
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

function makeRow(item: ReviewQueueItemView, whyChip: string): InsightRowView {
  return { id: item.id, kind: "overdue_review", item, whyChip }
}

function makeInsights(
  overrides: Partial<ReviewerInsightsView> = {}
): ReviewerInsightsView {
  return {
    needsYouNow: [],
    mightBeMissing: [],
    stalledOnYou: [],
    whileAway: [],
    hygiene: [],
    totalCount: 0,
    ...overrides,
  }
}

describe("buildAiDashboardInput", () => {
  it("keeps the board-scoped open review universe and aggregates flags", () => {
    const urgent = makeItem({ id: "pr_urgent" })
    const waiting = makeItem({
      id: "pr_waiting",
      waitingOn: "author",
      waitingUrgency: "none",
      workflowState: "waiting_on_author",
    })
    const closed = makeItem({ id: "pr_closed", state: "merged" })
    const offBoard = makeItem({ id: "pr_off_board" })
    const insights = makeInsights({
      needsYouNow: [
        makeRow(urgent, "Your turn for 4d"),
        makeRow(offBoard, "Outside scope"),
      ],
      hygiene: [makeRow(waiting, "No movement for 8d")],
    })

    const input = buildAiDashboardInput(insights, [urgent, waiting, closed])

    expect(input.items.map((item) => item.id)).toEqual([
      "pr_urgent",
      "pr_waiting",
    ])
    expect(input.items[0]?.chips).toEqual(["needs you now: Your turn for 4d"])
    expect(input.items[1]?.chips).toEqual(["aging: No movement for 8d"])
    expect(input.metrics.openReviewCount).toBe(2)
    expect(input.metrics.yourMoveCount).toBe(1)
    expect(input.metrics.waitingOnAuthorCount).toBe(1)
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

    const input = buildAiDashboardInput(makeInsights(), [waiting, ...yourMove])

    expect(input.items).toHaveLength(30)
    expect(input.items[0]?.id).toBe("pr_you_0")
    expect(input.metrics.omittedCount).toBe(3)
  })
})

describe("buildAiDashboardPrompt", () => {
  it("lists metrics, facts, flags, unseen activity, and excerpts", () => {
    const item = makeItem({
      id: "pr_1",
      repository: "acme/api",
      number: 142,
      title: "Normalize webhooks",
      labels: [{ name: "backend" }],
      newCommitCount: 2,
      newReplyCount: 1,
      unresolvedThreadCount: 1,
      totalThreadCount: 3,
      checks: { state: "failure", totalCount: 1 },
      activityEvents: [
        {
          actor: "maya",
          action: "pushed 2 commits",
          isNew: true,
        },
      ] as ReviewQueueItemView["activityEvents"],
    })
    const input = buildAiDashboardInput(
      makeInsights({ needsYouNow: [makeRow(item, "Your turn for 4d")] }),
      [item]
    )
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

    expect(system).toContain("pure turn-tracking dashboard")
    expect(system).toContain("Do not assess code quality")
    expect(user).toContain("- open reviews: 1")
    expect(user).toContain("- id pr_1 | acme/api#142 | Normalize webhooks")
    expect(user).toContain("flag - needs you now: Your turn for 4d")
    expect(user).toContain("2 new commits")
    expect(user).toContain("checks failure")
    expect(user).toContain("labels: backend")
    expect(user).toContain("since last seen: maya pushed 2 commits")
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
