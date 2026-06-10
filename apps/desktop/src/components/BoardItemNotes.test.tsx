import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BoardItemNotes } from "./BoardItemNotes"

describe("BoardItemNotes", () => {
  it("renders saved notes as markdown", () => {
    const markup = renderToStaticMarkup(
      <BoardItemNotes value={"**Check rollout**\n\n- verify logs"} onSave={() => {}} />
    )

    expect(markup).toContain("<strong>Check rollout</strong>")
    expect(markup).toContain("<li>verify logs</li>")
    expect(markup).not.toContain("<textarea")
  })
})
