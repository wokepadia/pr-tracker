import { describe, expect, it } from "vitest"
import { buildChatBoardContext, buildChatSystemPrompt } from "./chat"
import type { AiDashboardInput, AiDashboardPrInput } from "./ai-dashboard"

function prInput(overrides: Partial<AiDashboardPrInput> = {}): AiDashboardPrInput {
  return {
    id: "github:acme~web:42",
    repository: "acme/web",
    number: 42,
    title: "Add retry guard",
    authorLogin: "author",
    waitingOn: "you",
    waitingAge: "2h",
    waitingUrgency: "elevated",
    isStalled: false,
    openedAt: "yesterday",
    updatedAt: "1h ago",
    state: "open",
    reason: "You were requested for review.",
    newCommitCount: 1,
    newReplyCount: 0,
    unresolvedThreadCount: 1,
    totalThreadCount: 2,
    awaitingYourReplyCount: 1,
    reviewRounds: 1,
    approvalStale: false,
    userLastReviewDecision: "none",
    labels: ["bug"],
    otherReviewers: [],
    unseenEvents: [],
    unresolvedThreads: [],
    ...overrides,
  }
}

function dashboardInput(items: AiDashboardPrInput[]): AiDashboardInput {
  return {
    metrics: {
      openReviewCount: items.length,
      repositoryCount: new Set(items.map((item) => item.repository)).size,
      yourMoveCount: items.filter((item) => item.waitingOn === "you").length,
      waitingOnAuthorCount: items.filter((item) => item.waitingOn === "author").length,
      stalledCount: items.filter((item) => item.isStalled).length,
      activeSinceLastVisitCount: 0,
      omittedCount: 0,
    },
    items,
  }
}

describe("chat grounding", () => {
  it("renders the board pull requests and their facts into the context", () => {
    const context = buildChatBoardContext(
      dashboardInput([
        prInput({
          description: "Guards the retry loop with a max-attempts counter.",
          checksState: "failure",
          discussionExcerpts: [
            {
              actor: "viewer",
              body: "Could this loop forever?",
              occurredAt: "2026-06-11T10:00:00.000Z",
              source: "review_comment",
              filePath: "src/retry.ts",
              line: 88,
            },
          ],
        }),
      ])
    )

    expect(context).toContain("acme/web#42 — Add retry guard")
    expect(context).toContain("author: author")
    expect(context).toContain("waiting on: you for 2h")
    expect(context).toContain("Guards the retry loop")
    expect(context).toContain("checks: failure")
    expect(context).toContain("Could this loop forever?")
    expect(context).toContain("src/retry.ts:88")
  })

  it("notes lower-priority pull requests that were omitted from the detail", () => {
    const input = dashboardInput([prInput()])
    input.metrics.omittedCount = 7
    const context = buildChatBoardContext(input)
    expect(context).toContain("7 lower-priority board pull request(s)")
  })

  it("states plainly when the board has no open pull requests", () => {
    const context = buildChatBoardContext(dashboardInput([]))
    expect(context).toContain("no open pull requests on the board")
  })

  it("embeds the grounding rules and the board context in the system prompt", () => {
    const prompt = buildChatSystemPrompt(dashboardInput([prInput()]))
    expect(prompt).toContain("Answer ONLY from the board pull requests")
    expect(prompt).toContain("say you don't have that information")
    expect(prompt).toContain("acme/web#42 — Add retry guard")
  })

  it("never includes a pull request that is not on the board", () => {
    const context = buildChatBoardContext(
      dashboardInput([prInput({ repository: "acme/web", number: 42 })])
    )
    // A different PR the model might be asked about must not appear.
    expect(context).not.toContain("#99")
    expect(context).not.toContain("other/repo")
  })
})
