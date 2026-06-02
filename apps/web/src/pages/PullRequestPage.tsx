import { Link, useParams } from "@tanstack/react-router"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  BellOff,
  Check,
  Clock3,
  ExternalLink,
  GitCommitHorizontal,
  MessageSquareText,
  Pin,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { getPullRequest, markPullRequestSeen } from "@/api"
import { formatCount, pluralize } from "@/lib/copy"
import { cn } from "@/lib/utils"
import {
  toReviewQueueItemView,
  type ActivityEventView,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import {
  hasLocalQueueState,
  loadLocalQueueState,
  saveLocalQueueState,
  type LocalPullRequestQueueState,
  type LocalQueueStateByPullRequestId,
} from "@/reviewer/local-queue-state"
import type { ReviewDecision } from "@pr-tracker/core"

const reviewDecisionLabels: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes req.",
  commented: "commented",
}

export function PullRequestPage() {
  const { pullRequestId } = useParams({ from: "/pull-requests/$pullRequestId" })
  const queryClient = useQueryClient()
  const [caughtUpError, setCaughtUpError] = useState(false)
  const [localQueueState, setLocalQueueState] =
    useState<LocalQueueStateByPullRequestId>(() => {
      if (typeof window === "undefined") return {}
      return loadLocalQueueState(window.localStorage)
    })
  const detailQuery = useQuery({
    queryKey: ["pull-request", pullRequestId],
    queryFn: () => getPullRequest(pullRequestId),
  })
  const markSeenMutation = useMutation({
    mutationFn: markPullRequestSeen,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["pull-request", pullRequestId] }),
      ])
    },
  })
  const detail = detailQuery.data
  const item = detail
    ? toReviewQueueItemView(
        detail.item,
        new Map(detail.actors.map((actor) => [actor.id, actor])),
        detail.viewer.id
      )
    : undefined

  useEffect(() => {
    saveLocalQueueState(window.localStorage, localQueueState)
  }, [localQueueState])

  function updateLocalItemState(
    itemId: string,
    update: (current: LocalPullRequestQueueState) => LocalPullRequestQueueState
  ) {
    setLocalQueueState((current) => {
      const next = { ...current }
      const nextItemState = update(current[itemId] ?? {})

      if (hasLocalQueueState(nextItemState)) {
        next[itemId] = nextItemState
      } else {
        delete next[itemId]
      }

      return next
    })
  }

  function snoozePullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (itemState.snoozed || itemState.muted) return
    updateLocalItemState(itemId, (current) => ({
      ...current,
      muted: undefined,
      snoozed: true,
    }))
  }

  function restorePullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (!itemState.snoozed && !itemState.muted) return
    updateLocalItemState(itemId, (current) => {
      const next = { ...current }
      delete next.snoozed
      delete next.muted
      return next
    })
  }

  function togglePinPullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (itemState.snoozed || itemState.muted) return
    updateLocalItemState(itemId, (current) => ({
      ...current,
      pinned: current.pinned ? undefined : true,
    }))
  }

  function mutePullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (itemState.muted) return
    updateLocalItemState(itemId, () => ({ muted: true }))
  }

  async function markCaughtUpById(itemId: string) {
    setCaughtUpError(false)
    markSeenMutation.reset()
    await markSeenMutation.mutateAsync(itemId).catch(() => {
      setCaughtUpError(true)
    })
  }

  useEffect(() => {
    if (!item) return
    const shortcutItem = item

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!["e", "s", "p", "m", "c"].includes(event.key)) return

      const activeElement = document.activeElement
      const activeTag = activeElement?.tagName
      const isEditingText =
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        activeTag === "SELECT" ||
        activeElement?.getAttribute("contenteditable") === "true"
      if (isEditingText) return
      if (activeTag === "BUTTON" || activeTag === "A") return

      event.preventDefault()

      if (event.key === "e") {
        window.open(shortcutItem.url, "_blank", "noreferrer")
        return
      }

      if (event.key === "s") {
        const itemState = localQueueState[shortcutItem.id] ?? {}
        if (itemState.snoozed) {
          restorePullRequestById(shortcutItem.id)
        } else if (!itemState.muted) {
          snoozePullRequestById(shortcutItem.id)
        }
        return
      }

      if (event.key === "p") {
        togglePinPullRequestById(shortcutItem.id)
        return
      }

      if (event.key === "m") {
        const itemState = localQueueState[shortcutItem.id] ?? {}
        if (itemState.muted) {
          restorePullRequestById(shortcutItem.id)
        } else {
          mutePullRequestById(shortcutItem.id)
        }
        return
      }

      if (shortcutItem.unseenEventCount > 0 && !markSeenMutation.isPending) {
        void markCaughtUpById(shortcutItem.id)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [item, localQueueState, markSeenMutation])

  if (detailQuery.isLoading) {
    return <DetailStatusPanel title="Loading pull request" />
  }

  if (detailQuery.isError || !item) {
    return (
      <DetailStatusPanel
        title="Could not load pull request"
        detail="The API did not return this reviewer pull request."
      />
    )
  }

  const loadedItem = item
  const newEvents = loadedItem.activityEvents.filter((event) => event.isNew)
  const oldEvents = loadedItem.activityEvents.filter((event) => !event.isNew)
  const reReviewRequested = loadedItem.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )
  const loadedItemLocalState = localQueueState[loadedItem.id] ?? {}
  const isPinned = Boolean(loadedItemLocalState.pinned)
  const isSnoozed = Boolean(loadedItemLocalState.snoozed)
  const isMuted = Boolean(loadedItemLocalState.muted)

  function snoozePullRequest() {
    snoozePullRequestById(loadedItem.id)
  }

  function restorePullRequest() {
    restorePullRequestById(loadedItem.id)
  }

  function togglePinPullRequest() {
    togglePinPullRequestById(loadedItem.id)
  }

  function mutePullRequest() {
    mutePullRequestById(loadedItem.id)
  }

  async function markCaughtUp() {
    await markCaughtUpById(loadedItem.id)
  }

  return (
    <div className="min-h-[760px] bg-[#242420]">
      <DetailHeader item={loadedItem} />
      <ContextBand
        item={loadedItem}
        newEventCount={newEvents.length}
        reReviewRequested={reReviewRequested}
      />
      <div className="grid grid-cols-1 gap-0 border-t border-white/10 xl:grid-cols-[62fr_38fr]">
        <main className="min-w-0 px-7 py-6">
          <div className="mb-4 font-mono text-[10.5px] tracking-[0.12em] text-[#8e8b82] uppercase">
            Activity · newest first
          </div>
          <Timeline
            newEvents={newEvents}
            oldEvents={oldEvents}
            lastSeenAt={item.lastSeenAt}
          />
        </main>
        <DetailSideRail
          item={loadedItem}
          newEventCount={newEvents.length}
          isPinned={isPinned}
          isSnoozed={isSnoozed}
          isMuted={isMuted}
          isMarkingSeen={markSeenMutation.isPending}
          caughtUpError={caughtUpError}
          onSnooze={snoozePullRequest}
          onRestore={restorePullRequest}
          onTogglePin={togglePinPullRequest}
          onMute={mutePullRequest}
          onCaughtUp={() => void markCaughtUp()}
        />
      </div>
    </div>
  )
}

function DetailStatusPanel({
  title,
  detail,
}: {
  title: string
  detail?: string
}) {
  return (
    <div className="grid min-h-[760px] place-items-center bg-[#242420] px-6">
      <div className="max-w-sm rounded-lg border border-white/10 bg-[#20201d] p-6 text-center">
        <h1 className="text-[18px] font-semibold tracking-tight text-[#f0ede4]">
          {title}
        </h1>
        {detail ? (
          <p className="mt-2 text-sm leading-6 text-[#9f9a91]">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

function DetailHeader({ item }: { item: ReviewQueueItemView }) {
  return (
    <header className="grid grid-cols-1 gap-5 border-b border-white/10 px-7 py-6 lg:grid-cols-[auto_1fr_auto]">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mt-1 h-8 w-fit justify-self-start text-[#bdb8ad] hover:bg-white/[0.04] hover:text-[#f0ede4]"
      >
        <Link to="/">
          <ArrowLeft className="h-4 w-4" />
          Inbox
        </Link>
      </Button>

      <div className="min-w-0">
        <div className="font-mono text-[11px] text-[#8e8b82]">
          {item.repository} / #{item.number}
          <span className="mx-2 text-white/20">·</span>
          opened by {item.authorLogin}
          <span className="mx-2 text-white/20">·</span>
          {item.openedAt}
        </div>
        <h1 className="mt-2 text-[28px] font-semibold leading-9 tracking-tight text-[#f0ede4]">
          {item.title}
        </h1>
        <div className="mt-4 grid max-w-[860px] grid-cols-1 gap-2 md:grid-cols-4">
          <DetailFact label="Updated" value={item.updatedAt} />
          <DetailFact
            label={detailQueueLabel(item)}
            value={item.waitingAge}
            hot={item.waitingOn === "you"}
          />
          <DetailFact label="Your role" value="required reviewer" />
          <DetailFact
            label="Unseen events"
            value={`${item.unseenEventCount} since ${item.lastSeenAt}`}
            hot={item.unseenEventCount > 0}
          />
        </div>
      </div>

      <div className="flex min-w-[190px] flex-col items-stretch gap-3">
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-[#d8d3c8]">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#d0a24c]" />
          {userReviewStanding(item.userLastReviewDecision)}
        </div>
        <Button
          asChild
          className="h-9 bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f]"
        >
          <a href={item.url} target="_blank" rel="noreferrer">
            Open in GitHub
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>
    </header>
  )
}

function DetailFact({
  label,
  value,
  hot,
}: {
  label: string
  value: string
  hot?: boolean
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="font-mono text-[9.5px] tracking-[0.1em] text-[#77736a] uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[12px] text-[#c9c5ba]",
          hot && "font-semibold text-[#d0a24c]"
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ContextBand({
  item,
  newEventCount,
  reReviewRequested,
}: {
  item: ReviewQueueItemView
  newEventCount: number
  reReviewRequested: boolean
}) {
  const changeCards = [
    {
      id: "commits",
      icon: GitCommitHorizontal,
      value: `+${item.newCommitCount}`,
      label: pluralize(item.newCommitCount, "new commit"),
      show: item.newCommitCount > 0,
    },
    {
      id: "replies",
      icon: MessageSquareText,
      value: String(item.newReplyCount),
      label: pluralize(item.newReplyCount, "new reply", "new replies"),
      show: item.newReplyCount > 0,
    },
    {
      id: "threads",
      value: `${item.unresolvedThreadCount}/${item.totalThreadCount}`,
      label: "threads open",
      show: item.totalThreadCount > 0,
      hot: item.unresolvedThreadCount > 0,
    },
    {
      id: "review",
      value: "yes",
      label: "re-review asked",
      show: reReviewRequested,
      hot: true,
    },
  ].filter((card) => card.show)
  const otherReviewerState =
    item.otherReviewers.length > 0
      ? item.otherReviewers
          .map((reviewer) => `${reviewer.login}: ${reviewDecisionLabel(reviewer.decision)}`)
          .join(" · ")
      : "no other reviewer state"
  const authorActivity = [
    item.newCommitCount > 0
      ? `+${formatCount(item.newCommitCount, "commit")}`
      : undefined,
    item.newReplyCount > 0
      ? formatCount(item.newReplyCount, "reply", "replies")
      : undefined,
  ].filter(Boolean)

  return (
    <section className="px-7 py-5">
      <div className="rounded-lg border border-white/10 bg-[#1f1f1c] p-5">
        <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] text-[#8e8b82] uppercase">
          <RotateCcw className="h-3.5 w-3.5 text-[#d0a24c]" />
          Review context
          <span className="text-white/20">·</span>
          {item.lastSeenAt}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <ContextFact
            label="your last review"
            value={
              item.userLastReviewAt
                ? `${reviewDecisionLabel(item.userLastReviewDecision)} · ${item.userLastReviewAt}`
                : reviewDecisionLabel(item.userLastReviewDecision)
            }
            hot={item.userLastReviewDecision === "pending"}
          />
          <ContextFact
            label="author activity"
            value={authorActivity.length > 0 ? authorActivity.join(" · ") : "none since last look"}
            hot={item.newCommitCount > 0 || item.newReplyCount > 0}
          />
          <ContextFact
            label="review request"
            value={reReviewRequested ? "requested again" : requestStateLabel(item)}
            hot={reReviewRequested || item.workflowState === "needs_review"}
          />
          <ContextFact
            label="open threads"
            value={`${item.unresolvedThreadCount}/${item.totalThreadCount}`}
            hot={item.unresolvedThreadCount > 0}
          />
          <ContextFact
            label="other reviewers"
            value={otherReviewerState}
          />
        </div>
        {changeCards.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {changeCards.map((card) => (
              <ChangeCard
                key={card.id}
                icon={card.icon}
                value={card.value}
                label={card.label}
                hot={card.hot}
              />
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-[13px] leading-5 text-[#d8d3c8]">
            No unseen review activity since your last visit.
          </div>
        )}
        <div className="mt-4 grid gap-2 text-[13px] leading-5 text-[#d8d3c8]">
          {item.activityEvents
            .filter((event) => event.isNew)
            .slice(0, 3)
            .map((event) => (
              <div key={event.id} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#d0a24c]" />
                <span>
                  <b>{event.actor}</b> {event.action}
                  {event.detail ? ` - ${event.detail}` : ""}
                </span>
              </div>
            ))}
        </div>
        <div className="mt-4 font-mono text-[11px] text-[#8e8b82]">
          {timelineEventSummary(newEventCount)}
        </div>
      </div>
    </section>
  )
}

function ContextFact({
  label,
  value,
  hot,
}: {
  label: string
  value: string
  hot?: boolean
}) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="font-mono text-[9.5px] tracking-[0.1em] text-[#77736a] uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-[11px] text-[#c9c5ba]",
          hot && "font-semibold text-[#d0a24c]"
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ChangeCard({
  icon: Icon,
  value,
  label,
  hot,
}: {
  icon?: ComponentType<{ className?: string }>
  value: string
  label: string
  hot?: boolean
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
      <div
        className={cn(
          "flex items-center gap-2 font-mono text-[22px] font-semibold text-[#f0ede4]",
          hot && "text-[#d0a24c]"
        )}
      >
        {Icon ? <Icon className="h-5 w-5" /> : null}
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] tracking-[0.1em] text-[#77736a] uppercase">
        {label}
      </div>
    </div>
  )
}

function Timeline({
  newEvents,
  oldEvents,
  lastSeenAt,
}: {
  newEvents: ActivityEventView[]
  oldEvents: ActivityEventView[]
  lastSeenAt: string
}) {
  return (
    <div className="relative">
      <div className="absolute top-2 bottom-2 left-[7px] w-px bg-white/10" />
      <div className="space-y-5">
        {newEvents.map((event) => (
          <TimelineItem key={event.id} event={event} isNew />
        ))}
        {newEvents.length > 0 && (
          <div className="relative flex items-center gap-3 py-1 pl-7">
            <span className="h-px flex-1 bg-white/10" />
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-[#d0a24c] uppercase">
              everything above is new since you last looked · {lastSeenAt}
            </span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
        )}
        {oldEvents.map((event) => (
          <TimelineItem key={event.id} event={event} />
        ))}
      </div>
    </div>
  )
}

function TimelineItem({
  event,
  isNew,
}: {
  event: ActivityEventView
  isNew?: boolean
}) {
  return (
    <div className="relative grid grid-cols-[112px_1fr] gap-5 pl-7">
      <span
        className={cn(
          "absolute top-1.5 left-0 h-3.5 w-3.5 rounded-full border border-white/20 bg-[#242420]",
          isNew && "border-[#d0a24c] bg-[#d0a24c]"
        )}
      />
      <div className="font-mono text-[11px] text-[#77736a]">{event.occurredAt}</div>
      <div>
        <div className="text-[13.5px] leading-5 text-[#ded9ce]">
          <b>{event.actor}</b> {event.action}
        </div>
        {event.detail ? (
          <div className="mt-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[12.5px] leading-5 text-[#bdb8ad]">
            {event.detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DetailSideRail({
  item,
  newEventCount,
  isPinned,
  isSnoozed,
  isMuted,
  isMarkingSeen,
  caughtUpError,
  onSnooze,
  onRestore,
  onTogglePin,
  onMute,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  newEventCount: number
  isPinned: boolean
  isSnoozed: boolean
  isMuted: boolean
  isMarkingSeen: boolean
  caughtUpError: boolean
  onSnooze: () => void
  onRestore: () => void
  onTogglePin: () => void
  onMute: () => void
  onCaughtUp: () => void
}) {
  const totalAdditions = item.changedFilesSinceLastSeen.reduce(
    (total, file) => total + (file.additions ?? 0),
    0
  )
  const totalDeletions = item.changedFilesSinceLastSeen.reduce(
    (total, file) => total + (file.deletions ?? 0),
    0
  )

  return (
    <aside className="border-t border-white/10 bg-[#20201d] px-5 py-6 xl:border-l xl:border-t-0">
      <RailCard title="Catch up">
        <div className="grid gap-2">
          {caughtUpError ? (
            <div className="rounded-md border border-[#d0a24c]/30 bg-[#d0a24c]/10 px-3 py-2 text-[12px] leading-5 text-[#d8d3c8]">
              Could not save caught-up state. Try again.
            </div>
          ) : null}
          <Button
            asChild
            className="h-9 justify-center bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f]"
          >
            <a href={item.url} target="_blank" rel="noreferrer">
              {newEventCount > 0
                ? `Review ${formatCount(newEventCount, "new event")}`
                : "Review in GitHub"}
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isMarkingSeen || newEventCount === 0}
            onClick={onCaughtUp}
            className="h-9 justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
          >
            <Check className="h-4 w-4" />
            {isMarkingSeen
              ? "Saving"
              : newEventCount === 0
                ? "All caught up"
                : "Mark all caught up"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isMuted}
              onClick={isSnoozed ? onRestore : onSnooze}
              className="h-9 justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
            >
              {isSnoozed ? (
                <RotateCcw className="h-4 w-4" />
              ) : (
                <Clock3 className="h-4 w-4" />
              )}
              {isSnoozed ? "Restore" : "Snooze"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isSnoozed || isMuted}
              aria-pressed={isPinned}
              onClick={onTogglePin}
              className="h-9 justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
            >
              <Pin className="h-4 w-4" />
              {isPinned ? "Unpin" : "Pin"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isSnoozed}
              onClick={isMuted ? onRestore : onMute}
              className="col-span-2 h-9 justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
            >
              <BellOff className="h-4 w-4" />
              {isMuted ? "Unmute" : "Mute"}
            </Button>
          </div>
        </div>
      </RailCard>

      <RailCard title="Where it stands">
        <RailKeyValue
          label="your review"
          value={reviewDecisionLabel(item.userLastReviewDecision)}
        />
        {item.otherReviewers.map((reviewer) => (
          <RailKeyValue
            key={reviewer.login}
            label={reviewer.login}
            value={
              reviewer.decision === "pending"
                ? "pending"
                : reviewDecisionLabels[reviewer.decision]
            }
          />
        ))}
        <RailKeyValue
          label="mergeable"
          value={detailMergeableLabel(item)}
        />
        {item.changedFilesSinceLastSeen.length > 0 ? (
          <RailKeyValue
            label="size"
            value={`+${totalAdditions} / -${totalDeletions}`}
          />
        ) : null}
      </RailCard>

      {item.changedFilesSinceLastSeen.length > 0 ? (
        <RailCard title="Changed files">
          <div className="grid gap-1">
            {item.changedFilesSinceLastSeen.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-3 rounded-[4px] px-1 py-1 font-mono text-[11px] text-[#bdb8ad]"
              >
                <span className="truncate">{file.path}</span>
                <span className="text-[#8e8b82]">
                  +{file.additions} / -{file.deletions}
                </span>
              </div>
            ))}
          </div>
        </RailCard>
      ) : null}
    </aside>
  )
}

function RailCard({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 font-mono text-[10.5px] tracking-[0.12em] text-[#9f9a91] uppercase">
        {title}
      </div>
      {children}
    </section>
  )
}

function RailKeyValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2 font-mono text-[11px]">
        <span className="text-[#8e8b82]">{label}</span>
        <span className="text-[#d8d3c8]">{value}</span>
      </div>
      <Separator className="bg-white/10 last:hidden" />
    </>
  )
}

function reviewDecisionLabel(decision: ReviewDecision | "pending"): string {
  return decision === "pending" ? "pending" : reviewDecisionLabels[decision]
}

function userReviewStanding(decision: ReviewDecision | "pending"): string {
  if (decision === "approved") return "You approved"
  if (decision === "changes_requested") return "You requested changes"
  if (decision === "commented") return "You commented"
  return "No review yet"
}

function detailQueueLabel(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") return "Waiting on you"
  if (item.waitingOn === "author") return "Waiting on author"
  if (item.laneId === "approved") return "Already approved"
  if (item.laneId === "caught_up") return "Caught up"
  if (item.laneId === "stale") return "Stale"
  return "Watching"
}

function detailMergeableLabel(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") return "blocked · you"
  if (item.waitingOn === "author") return "waiting · author"
  if (item.laneId === "approved") return "approved · watching"
  if (item.laneId === "caught_up") return "caught up · watching"
  if (item.laneId === "stale") return "stale · watching"
  return "watching"
}

function requestStateLabel(item: ReviewQueueItemView): string {
  if (item.workflowState === "needs_review") return "requested"
  if (item.workflowState === "updated_since_review") return "changed after review"
  if (item.workflowState === "waiting_on_author") return "not requested"
  if (item.workflowState === "needs_thread_attention") return "thread attention"
  if (item.workflowState === "caught_up") return "caught up"
  return "not requested"
}

function timelineEventSummary(newEventCount: number): string {
  if (newEventCount === 0) {
    return "No new events to show in the timeline."
  }

  return `${formatCount(newEventCount, "new event")} shown in the timeline below.`
}
