import { describe, expect, it } from "vitest"

import { selectBoardScopedItems } from "./board-scope"

describe("selectBoardScopedItems", () => {
  it("keeps only items that have a board row", () => {
    const items = [
      { id: "pr_on_board" },
      { id: "pr_with_notes" },
      { id: "pr_off_board" },
    ]

    expect(
      selectBoardScopedItems(items, {
        pr_on_board: {},
        pr_with_notes: { notes: "check the migration path" },
        pr_unrelated: {},
      })
    ).toEqual([{ id: "pr_on_board" }, { id: "pr_with_notes" }])
  })

  it("returns nothing when the board is empty", () => {
    expect(selectBoardScopedItems([{ id: "pr_1" }], {})).toEqual([])
  })
})
