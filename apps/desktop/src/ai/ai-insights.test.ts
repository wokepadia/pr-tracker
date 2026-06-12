import { describe, expect, it } from "vitest"

import type { ReviewerInsightsView, InsightRowView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"
import {
  buildAiInsightsInput,
  buildAiInsightsPrompt,
  normalizeAiInsightsContent,
} from "./ai-insights"

function makeItem(
  overrides: Partial<ReviewQueueItemView> & { id: string }
): ReviewQueueItemView {
  return {
    repository: "acme/api",
    number: 1,
    title: `Title ${overrides.id}`,
    waitingOn: "you",
    waitingAge: "4d",
    unseenEventCount: 0,
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

describe("buildAiInsightsInput", () => {
  it("orders sections edges-first and aggregates chips per pull request", () => {
    const urgent = makeItem({ id: "pr_urgent" })
    const stalled = makeItem({ id: "pr_stalled", waitingOn: "none" })
    const aging = makeItem({ id: "pr_aging", waitingOn: "author" })
    const missing = makeItem({ id: "pr_missing" })
    const unseenOnly = makeItem({
      id: "pr_unseen",
      unseenEventCount: 2,
      activityEvents: [
        { actor: "maya", action: "pushed 2 commits", isNew: true },
        { actor: "sam", action: "commented", isNew: false },
      ] as ReviewQueueItemView["activityEvents"],
    })
    const insights = makeInsights({
      needsYouNow: [
        makeRow(urgent, "Your turn for 4d"),
        makeRow(urgent, "2 threads await your reply"),
      ],
      stalledOnYou: [makeRow(stalled, "No activity for 9d — maya spoke last")],
      hygiene: [makeRow(aging, "Nothing moved for 9d")],
      mightBeMissing: [makeRow(missing, "Snoozed, but 4 events arrived")],
    })

    const input = buildAiInsightsInput(insights, [
      urgent,
      stalled,
      aging,
      missing,
      unseenOnly,
    ])

    expect(input.items.map((item) => item.id)).toEqual([
      "pr_urgent",
      "pr_stalled",
      "pr_aging",
      "pr_unseen",
      "pr_missing",
    ])
    expect(input.items[0]?.chips).toEqual([
      "needs you now: Your turn for 4d",
      "needs you now: 2 threads await your reply",
    ])
    expect(input.items[1]?.chips).toEqual([
      "stalled on you: No activity for 9d — maya spoke last",
    ])
    expect(input.items[3]?.unseenEvents).toEqual(["maya pushed 2 commits"])
    expect(input.omittedCount).toBe(0)
  })

  it("drops insight rows for pull requests outside the scope universe", () => {
    const onBoard = makeItem({ id: "pr_on_board" })
    const offBoard = makeItem({ id: "pr_off_board" })
    const insights = makeInsights({
      needsYouNow: [
        makeRow(onBoard, "Your turn for 4d"),
        makeRow(offBoard, "Your turn for 9d"),
      ],
    })

    const input = buildAiInsightsInput(insights, [onBoard])

    expect(input.items.map((item) => item.id)).toEqual(["pr_on_board"])
    expect(input.omittedCount).toBe(0)
  })

  it("keeps the edges when the queue exceeds the cap", () => {
    const urgent = Array.from({ length: 45 }, (_value, index) =>
      makeItem({ id: `pr_u${index}` })
    )
    const missing = Array.from({ length: 5 }, (_value, index) =>
      makeItem({ id: `pr_m${index}` })
    )
    const insights = makeInsights({
      needsYouNow: urgent.map((item) => makeRow(item, "urgent")),
      mightBeMissing: missing.map((item) => makeRow(item, "missing")),
    })

    const input = buildAiInsightsInput(insights, [...urgent, ...missing])

    expect(input.items).toHaveLength(40)
    expect(input.omittedCount).toBe(10)
    expect(input.items[0]?.id).toBe("pr_u0")
    // The tail keeps the might-be-missing contradictions.
    expect(input.items.at(-1)?.id).toBe("pr_m4")
    expect(input.items.at(-5)?.id).toBe("pr_m0")
  })
})

describe("buildAiInsightsPrompt", () => {
  it("lists records with flags and unseen activity", () => {
    const item = makeItem({
      id: "pr_1",
      repository: "acme/api",
      number: 142,
      title: "Normalize webhooks",
    })
    const insights = makeInsights({
      needsYouNow: [makeRow(item, "Your turn for 4d")],
    })
    const input = buildAiInsightsInput(insights, [item])
    const promptItem = input.items[0]
    if (!promptItem) {
      throw new Error("Expected AI insights input item.")
    }
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

    const { system, user } = buildAiInsightsPrompt(input)

    expect(system).toContain("never invent pull requests")
    expect(system).toContain("never re-judge")
    expect(user).toContain("- id pr_1 | acme/api#142 | Normalize webhooks")
    expect(user).toContain("waiting on: you for 4d")
    expect(user).toContain("flag — needs you now: Your turn for 4d")
    expect(user).toContain(
      "discussion — [2026-06-10T09:00:00.000Z] review_comment on src/webhooks.ts:44 by maya:"
    )
    expect(user).toContain("The webhook retry state now matches")
    expect(user).toContain("stalled-on-you notes grouping the pull requests")
    expect(user).toContain("sweep notes grouping the remaining pull requests")
  })

  it("is deterministic and notes omissions", () => {
    const items = Array.from({ length: 45 }, (_value, index) =>
      makeItem({ id: `pr_${index}` })
    )
    const insights = makeInsights({
      needsYouNow: items.map((item) => makeRow(item, "urgent")),
    })
    const input = buildAiInsightsInput(insights, items)

    expect(buildAiInsightsPrompt(input)).toEqual(buildAiInsightsPrompt(input))
    expect(buildAiInsightsPrompt(input).user).toContain(
      "(5 lower-priority pull requests omitted)"
    )
  })
})

describe("normalizeAiInsightsContent", () => {
  it("drops unknown ids, dedupes, and trims across all sections", () => {
    expect(
      normalizeAiInsightsContent(
        {
          headline: " Two PRs need you. ",
          readingOrder: [
            { pullRequestId: "pr_1", why: " Overdue 4d. " },
            { pullRequestId: "pr_1", why: "duplicate" },
            { pullRequestId: "pr_invented", why: "hallucinated" },
            { pullRequestId: "pr_2", why: "" },
          ],
          stalledOnYou: [
            { pullRequestId: "pr_2", note: " You owe maya a reply. " },
            { pullRequestId: "pr_2", note: "duplicate" },
            { pullRequestId: "pr_invented", note: "hallucinated" },
          ],
          whileAway: [{ pullRequestId: "pr_2", note: "Merged without you." }],
          sweep: [
            { pullRequestId: "pr_3", note: " Stalled for 11d. " },
            { pullRequestId: "pr_invented", note: "hallucinated" },
          ],
        },
        ["pr_1", "pr_2", "pr_3"]
      )
    ).toEqual({
      headline: "Two PRs need you.",
      readingOrder: [{ pullRequestId: "pr_1", why: "Overdue 4d." }],
      stalledOnYou: [{ pullRequestId: "pr_2", note: "You owe maya a reply." }],
      whileAway: [{ pullRequestId: "pr_2", note: "Merged without you." }],
      sweep: [{ pullRequestId: "pr_3", note: "Stalled for 11d." }],
    })
  })

  it("caps the stalled-on-you section at four notes", () => {
    const ids = ["pr_1", "pr_2", "pr_3", "pr_4", "pr_5"]
    const content = normalizeAiInsightsContent(
      {
        headline: "Reply queue.",
        readingOrder: [],
        stalledOnYou: ids.map((id) => ({
          pullRequestId: id,
          note: `Note ${id}`,
        })),
        whileAway: [],
        sweep: [],
      },
      ids
    )

    expect(content.stalledOnYou.map((entry) => entry.pullRequestId)).toEqual([
      "pr_1",
      "pr_2",
      "pr_3",
      "pr_4",
    ])
  })

  it("caps the sweep section at four notes", () => {
    const ids = ["pr_1", "pr_2", "pr_3", "pr_4", "pr_5"]
    const content = normalizeAiInsightsContent(
      {
        headline: "Sweep day.",
        readingOrder: [],
        stalledOnYou: [],
        whileAway: [],
        sweep: ids.map((id) => ({ pullRequestId: id, note: `Note ${id}` })),
      },
      ids
    )

    expect(content.sweep.map((entry) => entry.pullRequestId)).toEqual([
      "pr_1",
      "pr_2",
      "pr_3",
      "pr_4",
    ])
  })

  it("throws without a headline", () => {
    expect(() =>
      normalizeAiInsightsContent({ readingOrder: [], whileAway: [] }, [])
    ).toThrow("The model response was missing the insights headline.")
  })
})
