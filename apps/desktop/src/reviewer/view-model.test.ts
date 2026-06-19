import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSampleInbox } from "@pr-tracker/reviewer-workflow"
import {
  buildInboxView,
  canMarkReviewItemCaughtUp,
  toReviewQueueItemView,
} from "./view-model"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
  WorkflowState,
} from "@pr-tracker/reviewer-workflow"

afterEach(() => {
  vi.useRealTimers()
})

describe("reviewer view model", () => {
  it("maps the inbox into board-scoped active and inactive items", () => {
    const view = buildInboxView(buildSampleInbox())

    expect(view.items.map((item) => item.id)).toEqual(["pr_1", "pr_2", "pr_3"])
    expect(Array.isArray(view.inactiveItems)).toBe(true)
  })

  it("counts only unseen deterministic activity facts", () => {
    const view = buildInboxView(buildSampleInbox())

    const requestedReview = view.items.find((item) => item.id === "pr_1")
    const updatedAfterApproval = view.items.find((item) => item.id === "pr_2")
    const waitingOnAuthor = view.items.find((item) => item.id === "pr_3")

    expect(requestedReview).toMatchObject({
      newCommitCount: 0,
      newReplyCount: 0,
      totalThreadCount: 0,
      unseenEventCount: 1,
      userLastReviewDecision: "pending",
    })
    expect(updatedAfterApproval).toMatchObject({
      newCommitCount: 1,
      newReplyCount: 0,
      totalThreadCount: 0,
      unseenEventCount: 1,
      userLastReviewDecision: "approved",
    })
    expect(waitingOnAuthor).toMatchObject({
      newCommitCount: 0,
      newReplyCount: 0,
      unresolvedThreadCount: 1,
      totalThreadCount: 1,
      unseenEventCount: 0,
      userLastReviewDecision: "changes_requested",
    })
  })

  it("normalizes activity text without duplicating the actor", () => {
    const view = buildInboxView(buildSampleInbox())

    const requestedReview = view.items.find((item) => item.id === "pr_1")
    const reviewRequestEvent = requestedReview?.activityEvents[0]

    expect(reviewRequestEvent).toMatchObject({
      actor: "maya",
      action: "requested your review",
      isNew: true,
    })
  })

  it("maps author avatar URLs into queue rows", () => {
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        turn: { owner: "viewer" as const },
        evidence: [],
        unseenActivityCount: 0,
        unansweredReviewRequest: false,
        pullRequest: {
          id: "pr_avatar",
          repository: "acme/api",
          number: 145,
          title: "Show author avatars",
          description: "Adds avatars beside each pull request author.",
          url: "https://github.com/acme/api/pull/145",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "frontend", color: "a2eeef" },
          ],
          assigneeIds: ["triage"],
          requestedReviewerIds: [],
          reviews: [],
          threads: [],
          activity: [],
        },
      },
      new Map([
        ["viewer", { id: "viewer", login: "you" }],
        [
          "maya",
          {
            id: "maya",
            login: "maya",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
          },
        ],
        [
          "triage",
          {
            id: "triage",
            login: "triage",
            avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
          },
        ],
      ]),
      "viewer"
    )

    expect(view).toMatchObject({
      authorLogin: "maya",
      authorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "frontend", color: "a2eeef" },
      ],
      assignees: [
        {
          login: "triage",
          avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
        },
      ],
      description: "Adds avatars beside each pull request author.",
    })
  })

  it("uses the newest unseen activity when calculating waiting age", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        turn: { owner: "viewer" as const },
        evidence: [],
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 2,
        unansweredReviewRequest: false,
        pullRequest: {
          id: "pr_unsorted",
          repository: "acme/api",
          number: 143,
          title: "Use newest activity for queue age",
          url: "https://github.com/acme/api/pull/143",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          requestedReviewerIds: ["viewer"],
          reviews: [],
          threads: [],
          activity: [
            {
              id: "old-new",
              type: "comment",
              actorId: "maya",
              occurredAt: "2026-06-01T09:00:00.000Z",
              title: "Maya replied yesterday",
            },
            {
              id: "latest-new",
              type: "commit",
              actorId: "maya",
              occurredAt: "2026-06-02T11:00:00.000Z",
              title: "Maya pushed 1 commit",
            },
          ],
        },
      },
      actorById,
      "viewer"
    )

    expect(view.waitingAge).toBe("1h")
  })

  it("maps pull request activity links into activity event views", () => {
    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        turn: { owner: "viewer" as const },
        evidence: [],
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 1,
        unansweredReviewRequest: false,
        pullRequest: {
          id: "pr_linked_activity",
          repository: "acme/api",
          number: 146,
          title: "Link update activity",
          url: "https://github.com/acme/api/pull/146",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          requestedReviewerIds: ["viewer"],
          reviews: [],
          threads: [],
          activity: [
            {
              id: "updated",
              type: "pull_request",
              actorId: "maya",
              occurredAt: "2026-06-02T11:00:00.000Z",
              title: "maya updated this pull request",
              url: "https://github.com/acme/api/pull/146",
              diffUrl: "https://github.com/acme/api/pull/146/files",
            },
          ],
        },
      },
      actorById,
      "viewer"
    )

    expect(view.activityEvents[0]).toMatchObject({
      action: "updated this pull request",
      url: "https://github.com/acme/api/pull/146",
      diffUrl: "https://github.com/acme/api/pull/146/files",
    })
  })

  it("keeps the latest review decision for other reviewers", () => {
    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
      ["sam", { id: "sam", login: "sam" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        turn: { owner: "viewer" as const },
        evidence: [],
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 0,
        unansweredReviewRequest: false,
        pullRequest: {
          id: "pr_reviewers",
          repository: "acme/api",
          number: 144,
          title: "Track reviewer state by latest review",
          url: "https://github.com/acme/api/pull/144",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          requestedReviewerIds: ["viewer"],
          reviews: [
            {
              id: "sam-new",
              reviewerId: "sam",
              decision: "approved",
              submittedAt: "2026-06-02T10:00:00.000Z",
            },
            {
              id: "sam-old",
              reviewerId: "sam",
              decision: "changes_requested",
              submittedAt: "2026-06-01T10:00:00.000Z",
            },
          ],
          threads: [],
          activity: [],
        },
      },
      actorById,
      "viewer"
    )

    expect(view.otherReviewers).toEqual([{ login: "sam", decision: "approved" }])
  })

  it("treats the viewer case-insensitively across reviews, threads, and reviewer state", () => {
    const actorById = new Map([
      ["viewer", { id: "viewer", login: "you" }],
      ["maya", { id: "maya", login: "maya" }],
    ])
    const view = toReviewQueueItemView(
      {
        workflowState: "needs_review",
        reason: "You are requested as a reviewer.",
        turn: { owner: "viewer" as const },
        evidence: [],
        lastSeenAt: "2026-06-01T08:00:00.000Z",
        unseenActivityCount: 0,
        unansweredReviewRequest: false,
        pullRequest: {
          id: "pr_case",
          repository: "acme/api",
          number: 145,
          title: "Case-insensitive viewer identity",
          url: "https://github.com/acme/api/pull/145",
          authorId: "maya",
          state: "open",
          isDraft: false,
          createdAt: "2026-05-30T08:00:00.000Z",
          updatedAt: "2026-06-02T11:00:00.000Z",
          latestCommitSha: "c3",
          // GitHub's canonical lower-case login, while the viewer is passed
          // through as the upper-case casing the user typed at onboarding.
          requestedReviewerIds: ["viewer"],
          reviews: [
            {
              id: "v1",
              reviewerId: "viewer",
              decision: "changes_requested",
              submittedAt: "2026-06-01T10:00:00.000Z",
            },
          ],
          threads: [
            {
              id: "t1",
              isResolved: false,
              participantIds: ["viewer", "maya"],
              lastActorId: "viewer",
              lastActivityAt: "2026-06-02T09:00:00.000Z",
            },
          ],
          activity: [],
        },
      },
      actorById,
      "VIEWER"
    )

    // The viewer's own review is recognized despite the casing difference,
    expect(view.userLastReviewDecision).toBe("changes_requested")
    // they are not double-listed as another reviewer,
    expect(view.otherReviewers).toEqual([])
    // and a thread they replied to last does not await their reply.
    expect(view.reviewThreads[0]?.awaitingYourReply).toBe(false)
  })

  it("guards caught-up actions to items with unseen activity", () => {
    expect(canMarkReviewItemCaughtUp(undefined, false)).toBe(false)
    expect(canMarkReviewItemCaughtUp({ unseenEventCount: 0 }, false)).toBe(false)
    expect(canMarkReviewItemCaughtUp({ unseenEventCount: 1 }, true)).toBe(false)
    expect(canMarkReviewItemCaughtUp({ unseenEventCount: 1 }, false)).toBe(true)
  })
})

describe("per-turn wait timers", () => {
  it("anchors the waiting age to the turn hand-off", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const item = classifiedItem("pr_turn", "needs_review")
    item.turn = {
      owner: "viewer" as const,
      since: "2026-06-02T09:00:00.000Z",
    }
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    expect(view.waitingOn).toBe("you")
    expect(view.waitingAge).toBe("3h")
    expect(view.waitingUrgency).toBe("none")
  })

  it("escalates urgency after one and three days on the same turn", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const elevated = classifiedItem("pr_elevated", "needs_review")
    elevated.turn = {
      owner: "viewer" as const,
      since: "2026-06-01T10:00:00.000Z",
    }
    const overdue = classifiedItem("pr_overdue", "waiting_on_author")
    overdue.turn = {
      owner: "author" as const,
      since: "2026-05-29T10:00:00.000Z",
    }

    const elevatedView = toReviewQueueItemView(
      elevated,
      sampleActorById(),
      "viewer"
    )
    const overdueView = toReviewQueueItemView(
      overdue,
      sampleActorById(),
      "viewer"
    )

    expect(elevatedView.waitingUrgency).toBe("elevated")
    expect(overdueView.waitingOn).toBe("author")
    expect(overdueView.waitingUrgency).toBe("overdue")
  })

  it("applies custom attention thresholds", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const item = classifiedItem("pr_custom_thresholds", "needs_review")
    item.turn = {
      owner: "viewer" as const,
      since: "2026-06-02T07:00:00.000Z",
    }

    const strictView = toReviewQueueItemView(item, sampleActorById(), "viewer", {
      elevatedAfterHours: 4,
      overdueAfterHours: 4,
    })
    const lenientView = toReviewQueueItemView(item, sampleActorById(), "viewer", {
      elevatedAfterHours: 8,
      overdueAfterHours: 12,
    })

    expect(strictView.waitingUrgency).toBe("overdue")
    expect(lenientView.waitingUrgency).toBe("none")
  })

  it("never marks unowned turns as urgent", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const item = classifiedItem("pr_quiet", "approved")
    item.turn = { owner: "none" as const, since: "2026-05-20T10:00:00.000Z" }
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    expect(view.waitingOn).toBe("none")
    expect(view.waitingUrgency).toBe("none")
  })

  it("derives the since-last-review delta with a compare link", () => {
    const view = buildInboxView(buildSampleInbox())

    const updatedAfterApproval = view.items.find((item) => item.id === "pr_2")

    expect(updatedAfterApproval?.approvalStale).toBe(true)
    expect(updatedAfterApproval?.sinceLastReview).toMatchObject({
      decision: "approved",
      replyCount: 0,
      threadsResolvedCount: 0,
      compareUrl: "https://github.com/acme/web/compare/f2..f3",
    })
    expect(updatedAfterApproval?.sinceLastReview?.commits).toHaveLength(1)
    expect(updatedAfterApproval?.sinceLastReview?.commits[0]).toMatchObject({
      title: "Ari pushed 1 commit",
    })

    const requestedReview = view.items.find((item) => item.id === "pr_1")
    expect(requestedReview?.sinceLastReview).toBeUndefined()
    expect(requestedReview?.approvalStale).toBe(false)
  })

  it("omits the delta when nothing happened since the review", () => {
    const item = classifiedItem("pr_no_delta", "waiting_on_author")
    item.pullRequest.reviews = [
      {
        id: "r_current",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-06-02T10:00:00.000Z",
        commitSha: "c3",
      },
    ]
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    expect(view.sinceLastReview).toBeUndefined()
    expect(view.approvalStale).toBe(false)
  })

  it("counts only other participants' replies since the review", () => {
    const item = classifiedItem("pr_replies", "updated_since_review")
    item.pullRequest.reviews = [
      {
        id: "r_cr",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-06-01T10:00:00.000Z",
        commitSha: "c3",
      },
    ]
    item.pullRequest.activity = [
      {
        id: "own-reply",
        type: "comment",
        actorId: "viewer",
        occurredAt: "2026-06-01T11:00:00.000Z",
        title: "You replied",
      },
      {
        id: "author-reply",
        type: "comment",
        actorId: "maya",
        occurredAt: "2026-06-01T12:00:00.000Z",
        title: "Maya replied",
      },
      {
        id: "earlier-comment",
        type: "comment",
        actorId: "maya",
        occurredAt: "2026-05-31T12:00:00.000Z",
        title: "Maya commented before the review",
      },
    ]
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    expect(view.sinceLastReview).toMatchObject({
      decision: "changes_requested",
      replyCount: 1,
      compareUrl: undefined,
    })
  })

  it("counts completed changes-requested rounds", () => {
    const item = classifiedItem("pr_rounds", "updated_since_review")
    item.pullRequest.reviews = [
      {
        id: "r1",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-05-28T10:00:00.000Z",
      },
      {
        id: "r2",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-05-30T10:00:00.000Z",
      },
      {
        id: "r3",
        reviewerId: "viewer",
        decision: "changes_requested",
        submittedAt: "2026-06-02T10:00:00.000Z",
      },
    ]
    item.pullRequest.activity = [
      {
        id: "c1",
        type: "commit",
        actorId: "maya",
        occurredAt: "2026-05-29T10:00:00.000Z",
        title: "Maya pushed 1 commit",
      },
      {
        id: "c2",
        type: "commit",
        actorId: "maya",
        occurredAt: "2026-05-31T10:00:00.000Z",
        title: "Maya pushed 1 commit",
      },
    ]
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    // The third changes-requested review has no push after it yet.
    expect(view.reviewRounds).toBe(2)
  })

  it("buckets diff sizes and omits the chip when size is unknown", () => {
    const sized = classifiedItem("pr_sized", "needs_review")
    sized.pullRequest.additions = 214
    sized.pullRequest.deletions = 58
    sized.pullRequest.changedFiles = 9
    const sizedView = toReviewQueueItemView(sized, sampleActorById(), "viewer")

    expect(sizedView.size).toEqual({
      bucket: "L",
      lineCount: 272,
      additions: 214,
      deletions: 58,
      fileCount: 9,
    })

    const tiny = classifiedItem("pr_tiny", "needs_review")
    tiny.pullRequest.additions = 12
    tiny.pullRequest.deletions = 3
    const tinyView = toReviewQueueItemView(tiny, sampleActorById(), "viewer")
    expect(tinyView.size?.bucket).toBe("S")

    const medium = classifiedItem("pr_medium", "needs_review")
    medium.pullRequest.additions = 120
    medium.pullRequest.deletions = 30
    const mediumView = toReviewQueueItemView(medium, sampleActorById(), "viewer")
    expect(mediumView.size?.bucket).toBe("M")

    const huge = classifiedItem("pr_huge", "needs_review")
    huge.pullRequest.additions = 1240
    huge.pullRequest.deletions = 310
    const hugeView = toReviewQueueItemView(huge, sampleActorById(), "viewer")
    expect(hugeView.size?.bucket).toBe("XL")

    const unknown = classifiedItem("pr_unknown_size", "needs_review")
    const unknownView = toReviewQueueItemView(unknown, sampleActorById(), "viewer")
    expect(unknownView.size).toBeUndefined()
  })

  it("maps classification evidence into display lines", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"))

    const item = classifiedItem("pr_evidence", "updated_since_review")
    item.evidence = [
      {
        id: "your_review",
        label: "You requested changes.",
        occurredAt: "2026-06-01T12:00:00.000Z",
        actorId: "viewer",
      },
      {
        id: "no_push",
        label: "The author has not pushed since your review.",
        actorId: "maya",
      },
    ]
    const view = toReviewQueueItemView(item, sampleActorById(), "viewer")

    expect(view.evidence).toEqual([
      {
        id: "your_review",
        label: "You requested changes.",
        occurredAt: "24h ago",
        actorLogin: "you",
      },
      {
        id: "no_push",
        label: "The author has not pushed since your review.",
        occurredAt: undefined,
        actorLogin: "maya",
      },
    ])
  })
})

function sampleActorById() {
  return new Map([
    ["viewer", { id: "viewer", login: "you" }],
    ["maya", { id: "maya", login: "maya" }],
  ])
}

function classifiedItem(
  id: string,
  workflowState: WorkflowState
): ClassifiedPullRequest {
  return {
    workflowState,
    reason: `${workflowState} reason`,
    turn: { owner: "none" },
    evidence: [],
    lastSeenAt: "2026-06-01T08:00:00.000Z",
    unseenActivityCount: 0,
    unansweredReviewRequest: false,
    pullRequest: {
      id,
      repository: "acme/api",
      number: 100,
      title: id,
      url: `https://github.com/acme/api/pull/${id}`,
      authorId: "maya",
      state: "open" as const,
      isDraft: false,
      createdAt: "2026-05-30T08:00:00.000Z",
      updatedAt: "2026-06-02T11:00:00.000Z",
      latestCommitSha: "c3",
      requestedReviewerIds: [],
      reviews: [],
      threads: [],
      activity: [],
    },
  }
}
