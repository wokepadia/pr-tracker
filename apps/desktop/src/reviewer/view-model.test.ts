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
  it("maps workflow classifications into reviewer queue lanes", () => {
    const view = buildInboxView(buildSampleInbox())

    expect(view.laneItems.needs_review.map((item) => item.id)).toEqual(["pr_1"])
    expect(view.laneItems.updated_since_review.map((item) => item.id)).toEqual([
      "pr_2",
    ])
    expect(view.laneItems.waiting_on_author.map((item) => item.id)).toEqual([
      "pr_3",
    ])
  })

  it("keeps approved and watching pull requests reachable as queue buckets", () => {
    const inbox: ReviewerInbox = {
      viewer: { id: "viewer", login: "you" },
      actors: [
        { id: "viewer", login: "you" },
        { id: "maya", login: "maya" },
      ],
      items: [
        classifiedItem("pr_approved", "approved"),
        classifiedItem("pr_caught_up", "caught_up"),
        classifiedItem("pr_watching", "watching"),
        classifiedItem("pr_stale", "stale"),
      ],
      sections: {
        needs_review: [],
        updated_since_review: [],
        waiting_on_author: [],
        needs_thread_attention: [],
        approved: [classifiedItem("pr_approved", "approved")],
        caught_up: [classifiedItem("pr_caught_up", "caught_up")],
        stale: [classifiedItem("pr_stale", "stale")],
        watching: [classifiedItem("pr_watching", "watching")],
        inactive: [],
      },
    }

    const view = buildInboxView(inbox)

    expect(view.laneItems.approved.map((item) => item.id)).toEqual([
      "pr_approved",
    ])
    expect(view.laneItems.watching.map((item) => item.id)).toEqual([
      "pr_caught_up",
      "pr_watching",
      "pr_stale",
    ])
    expect(view.approvedCount).toBe(1)
    expect(view.watchingCount).toBe(3)
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
      ]),
      "viewer"
    )

    expect(view).toMatchObject({
      authorLogin: "maya",
      authorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
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
