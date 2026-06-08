import { describe, expect, it } from "vitest"
import { formatCount, pluralize } from "./copy"

describe("copy helpers", () => {
  it("formats singular and plural counts", () => {
    expect(formatCount(1, "new event")).toBe("1 new event")
    expect(formatCount(2, "new event")).toBe("2 new events")
  })

  it("supports irregular plural labels", () => {
    expect(formatCount(1, "reply", "replies")).toBe("1 reply")
    expect(formatCount(3, "reply", "replies")).toBe("3 replies")
  })

  it("formats standalone singular and plural labels", () => {
    expect(pluralize(1, "new commit")).toBe("new commit")
    expect(pluralize(2, "new commit")).toBe("new commits")
  })
})
