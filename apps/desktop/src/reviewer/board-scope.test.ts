import { describe, expect, it } from "vitest"

import { selectBoardScopedItems } from "./board-scope"

describe("selectBoardScopedItems", () => {
  it("keeps only items with a board row, including snoozed and muted ones", () => {
    const items = [
      { id: "pr_active" },
      { id: "pr_snoozed" },
      { id: "pr_muted" },
      { id: "pr_off_board" },
    ]

    expect(
      selectBoardScopedItems(items, {
        pr_active: { bucketId: "inbox" },
        pr_snoozed: { snoozed: true },
        pr_muted: { muted: true },
        pr_unrelated: { bucketId: "later" },
      })
    ).toEqual([
      { id: "pr_active" },
      { id: "pr_snoozed" },
      { id: "pr_muted" },
    ])
  })

  it("returns nothing when the board is empty", () => {
    expect(selectBoardScopedItems([{ id: "pr_1" }], {})).toEqual([])
  })
})
