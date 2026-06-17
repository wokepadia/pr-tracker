import { describe, expect, it } from "vitest"

import {
  buildPrBriefPrompt,
  normalizePrBriefContent,
  type PrBriefPromptInput,
} from "./pr-brief"

function promptInput(
  overrides: Partial<PrBriefPromptInput> = {}
): PrBriefPromptInput {
  return {
    repository: "acme/api",
    number: 2184,
    title: "Migrate session auth to short-lived JWTs",
    body: "Replaces cookie sessions with short-lived JWTs.",
    authorLogin: "maya",
    viewerLogin: "you",
    state: "open",
    isDraft: false,
    additions: 265,
    deletions: 66,
    changedFiles: 9,
    waitingOn: "you",
    waitingAge: "2d",
    waitingUrgency: "overdue",
    isStalled: true,
    reason: "Maya re-requested your review.",
    userLastReviewDecision: "changes_requested",
    approvalStale: false,
    reviewRounds: 1,
    checksState: "failure",
    lastSeenLabel: "2h ago",
    otherReviewers: [{ login: "dev", decision: "approved" }],
    newEvents: [
      {
        type: "commit",
        actor: "maya",
        title: "Add rate-limiting to the login route",
        occurredAt: "2026-06-10T09:00:00.000Z",
      },
      {
        type: "review_comment",
        actor: "maya",
        title: "Replied on the token-expiry thread",
        body: "Switched to a 15-minute access window.",
        occurredAt: "2026-06-10T10:00:00.000Z",
      },
    ],
    threads: [
      {
        filePath: "auth/middleware.ts",
        line: 44,
        status: "unresolved",
        awaitingYourReply: true,
        isOutdated: false,
        lastActorLogin: "maya",
        participants: ["you", "maya"],
      },
      {
        filePath: "auth/tokenService.ts",
        status: "resolved",
        awaitingYourReply: false,
        isOutdated: false,
        lastActorLogin: "maya",
        participants: ["maya"],
      },
    ],
    comments: [
      {
        actor: "maya",
        body: "Happy to rotate refresh tokens on each use.",
        occurredAt: "2026-06-10T10:00:00.000Z",
        source: "review_comment",
        filePath: "auth/middleware.ts",
        line: 44,
      },
    ],
    files: [
      {
        path: "auth/middleware.ts",
        status: "modified",
        additions: 128,
        deletions: 64,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        path: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
      },
    ],
    ...overrides,
  }
}

describe("buildPrBriefPrompt", () => {
  it("includes turn facts, activity, threads, comments, and patches", () => {
    const { system, user } = buildPrBriefPrompt(promptInput())

    expect(system).toContain("never invent files")
    expect(system).toContain("lead with what it means for the reviewer")
    expect(user).toContain("synthesized takeaways")
    expect(user).toContain("Pull request #2184: Migrate session auth to short-lived JWTs")
    expect(user).toContain("The reviewer reading this brief is you.")
    expect(user).toContain("Size: +265 / -66 across 9 files")
    expect(user).toContain("Waiting on: you for 2d (urgency overdue, stalled)")
    expect(user).toContain("Head-commit checks: failure")
    expect(user).toContain("Reviewer last looked: 2h ago")
    expect(user).toContain("Other reviewers: dev approved")
    expect(user).toContain(
      "- [2026-06-10T09:00:00.000Z] commit by maya: Add rate-limiting to the login route"
    )
    expect(user).toContain(
      "- auth/middleware.ts:44 — unresolved, awaiting your reply, participants: you, maya, last reply by maya"
    )
    expect(user).toContain("Happy to rotate refresh tokens on each use.")
    expect(user).toContain("--- auth/middleware.ts (modified, +128 / -64)")
    expect(user).toContain("--- assets/logo.png (added, +0 / -0)")
    expect(user).toContain("(no text patch available)")
  })

  it("is deterministic for identical input", () => {
    expect(buildPrBriefPrompt(promptInput())).toEqual(
      buildPrBriefPrompt(promptInput())
    )
  })

  it("notes when nothing is new and there are no threads", () => {
    const { user } = buildPrBriefPrompt(
      promptInput({ newEvents: [], threads: [], comments: [] })
    )
    expect(user).toContain("(nothing new since the reviewer last looked)")
    expect(user).toContain("(no review threads)")
    expect(user).toContain("(no comment text cached locally)")
  })
})

describe("normalizePrBriefContent", () => {
  it("keeps valid fields and grounds thread notes to allowed files", () => {
    const content = normalizePrBriefContent(
      {
        yourMove: " It is your turn. ",
        whatThisDoes: {
          overview: " Swaps cookies for JWTs. ",
          changes: [
            { tag: "new", text: " Adds a tokenService. " },
            { tag: "bogus", text: "Defaults to chore." },
            { tag: "fix", text: "" },
          ],
        },
        conversation: {
          overview: " One thread open. ",
          threads: [
            { file: "auth/middleware.ts", note: "Awaiting your reply." },
            { file: "invented/path.ts", note: "Hallucinated." },
            { file: "auth/middleware.ts", note: "Duplicate file." },
          ],
        },
        sinceYouLooked: [
          { kind: "commit", text: "Maya pushed a fix.", detail: "a1b2c3d" },
          { kind: "weird", text: "Defaults to other." },
          { kind: "comment", text: "" },
        ],
        whatsNext: [" Reply on the thread. ", "", "Re-review the diff."],
      },
      ["auth/middleware.ts", "auth/tokenService.ts"]
    )

    expect(content).toEqual({
      yourMove: "It is your turn.",
      whatThisDoes: {
        overview: "Swaps cookies for JWTs.",
        changes: [
          { tag: "new", text: "Adds a tokenService." },
          { tag: "chore", text: "Defaults to chore." },
        ],
      },
      conversation: {
        overview: "One thread open.",
        threads: [{ file: "auth/middleware.ts", note: "Awaiting your reply." }],
      },
      sinceYouLooked: [
        { kind: "commit", text: "Maya pushed a fix.", detail: "a1b2c3d" },
        { kind: "other", text: "Defaults to other." },
      ],
      whatsNext: ["Reply on the thread.", "Re-review the diff."],
    })
  })

  it("throws when the your-move narrative is missing", () => {
    expect(() =>
      normalizePrBriefContent(
        { whatThisDoes: { overview: "x", changes: [] } },
        []
      )
    ).toThrow("The model response was missing the your-move narrative.")
  })

  it("throws when the change overview is missing", () => {
    expect(() =>
      normalizePrBriefContent({ yourMove: "Your turn." }, [])
    ).toThrow("The model response was missing the change overview.")
  })
})
