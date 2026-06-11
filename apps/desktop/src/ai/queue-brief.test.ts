import { describe, expect, it } from "vitest"

import type { ReviewerInsightsView, InsightRowView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"
import {
  buildQueueBriefInput,
  buildQueueBriefPrompt,
  normalizeQueueBriefContent,
} from "./queue-brief"

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
    whileAway: [],
    hygiene: [],
    totalCount: 0,
    ...overrides,
  }
}

describe("buildQueueBriefInput", () => {
  it("orders sections edges-first and aggregates chips per pull request", () => {
    const urgent = makeItem({ id: "pr_urgent" })
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
      hygiene: [makeRow(aging, "Nothing moved for 9d")],
      mightBeMissing: [makeRow(missing, "Snoozed, but 4 events arrived")],
    })

    const input = buildQueueBriefInput(
      insights,
      [urgent, aging, missing, unseenOnly],
      "2026-06-04T08:00:00.000Z"
    )

    expect(input.items.map((item) => item.id)).toEqual([
      "pr_urgent",
      "pr_aging",
      "pr_unseen",
      "pr_missing",
    ])
    expect(input.items[0]?.chips).toEqual([
      "needs you now: Your turn for 4d",
      "needs you now: 2 threads await your reply",
    ])
    expect(input.items[2]?.unseenEvents).toEqual(["maya pushed 2 commits"])
    expect(input.omittedCount).toBe(0)
    expect(input.previousVisitAt).toBe("2026-06-04T08:00:00.000Z")
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

    const input = buildQueueBriefInput(insights, [...urgent, ...missing])

    expect(input.items).toHaveLength(40)
    expect(input.omittedCount).toBe(10)
    expect(input.items[0]?.id).toBe("pr_u0")
    // The tail keeps the might-be-missing contradictions.
    expect(input.items.at(-1)?.id).toBe("pr_m4")
    expect(input.items.at(-5)?.id).toBe("pr_m0")
  })
})

describe("buildQueueBriefPrompt", () => {
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
    const input = buildQueueBriefInput(insights, [item])

    const { system, user } = buildQueueBriefPrompt(input)

    expect(system).toContain("never invent pull requests")
    expect(system).toContain("never re-judge")
    expect(user).toContain("- id pr_1 | acme/api#142 | Normalize webhooks")
    expect(user).toContain("waiting on: you for 4d")
    expect(user).toContain("flag — needs you now: Your turn for 4d")
  })

  it("is deterministic and notes omissions", () => {
    const items = Array.from({ length: 45 }, (_value, index) =>
      makeItem({ id: `pr_${index}` })
    )
    const insights = makeInsights({
      needsYouNow: items.map((item) => makeRow(item, "urgent")),
    })
    const input = buildQueueBriefInput(insights, items)

    expect(buildQueueBriefPrompt(input)).toEqual(buildQueueBriefPrompt(input))
    expect(buildQueueBriefPrompt(input).user).toContain(
      "(5 lower-priority pull requests omitted)"
    )
  })
})

describe("normalizeQueueBriefContent", () => {
  it("drops unknown ids, dedupes, and trims", () => {
    expect(
      normalizeQueueBriefContent(
        {
          headline: " Two PRs need you. ",
          needsYou: [
            { pullRequestId: "pr_1", why: " Overdue 4d. " },
            { pullRequestId: "pr_1", why: "duplicate" },
            { pullRequestId: "pr_invented", why: "hallucinated" },
            { pullRequestId: "pr_2", why: "" },
          ],
          whileAway: [{ pullRequestId: "pr_2", note: "Merged without you." }],
        },
        ["pr_1", "pr_2"]
      )
    ).toEqual({
      headline: "Two PRs need you.",
      needsYou: [{ pullRequestId: "pr_1", why: "Overdue 4d." }],
      whileAway: [{ pullRequestId: "pr_2", note: "Merged without you." }],
    })
  })

  it("throws without a headline", () => {
    expect(() =>
      normalizeQueueBriefContent({ needsYou: [], whileAway: [] }, [])
    ).toThrow("The model response was missing the brief headline.")
  })
})
