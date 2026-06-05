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
  ChevronsLeftRight,
  Clock3,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  MessageSquareText,
  Pin,
  RotateCcw,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ActivityEventLine } from "@/components/ActivityEventLine"
import { MarkdownContent } from "@/components/MarkdownContent"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { getPullRequest, markPullRequestSeen } from "@/api"
import { formatCount, pluralize } from "@/lib/copy"
import { cn, externalLinkProps } from "@/lib/utils"
import {
  canMarkReviewItemCaughtUp,
  toReviewQueueItemView,
  type ActivityEventView,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import {
  bucketIdForLocalQueueItem,
  canMuteLocalQueueItem,
  canPinLocalQueueItem,
  canSnoozeLocalQueueItem,
  hasLocalQueueState,
  loadLocalQueueState,
  loadUserBuckets,
  saveLocalQueueState,
  userBucketLabelFromId,
  type LocalPullRequestQueueState,
  type LocalQueueStateByPullRequestId,
  type UserBucketDefinition,
  type UserBucketId,
} from "@/reviewer/local-queue-state"
import { detailAttentionLabel } from "./pull-request-helpers"
import type { ReviewDecision } from "@pr-tracker/core"

const reviewDecisionLabels: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes req.",
  commented: "commented",
}

type DetailTone = "hot" | "changed" | "waiting" | "success" | "quiet"

const detailToneClasses: Record<DetailTone, string> = {
  hot: "border-amber-200 bg-amber-50 text-amber-800",
  changed: "border-sky-200 bg-sky-50 text-sky-800",
  waiting: "border-emerald-200 bg-emerald-50 text-emerald-800",
  success: "border-teal-200 bg-teal-50 text-teal-800",
  quiet: "border-border bg-muted/40 text-muted-foreground",
}

const detailDotClasses: Record<DetailTone, string> = {
  hot: "bg-amber-500",
  changed: "bg-sky-500",
  waiting: "bg-emerald-500",
  success: "bg-teal-500",
  quiet: "bg-slate-300",
}

const detailBucketToneClasses: Partial<Record<UserBucketId, DetailTone>> = {
  inbox: "hot",
  reviewing: "changed",
  waiting: "waiting",
  later: "quiet",
  done: "success",
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
  const [userBuckets] = useState<UserBucketDefinition[]>(() => {
    if (typeof window === "undefined") return []
    return loadUserBuckets(window.localStorage)
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

  function movePullRequestToBucket(itemId: string, bucketId: UserBucketId) {
    updateLocalItemState(itemId, (current) => ({
      ...current,
      bucketId,
    }))
  }

  function snoozePullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (!canSnoozeLocalQueueItem(itemState)) return
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
    if (!canPinLocalQueueItem(itemState)) return
    updateLocalItemState(itemId, (current) => ({
      ...current,
      pinned: current.pinned ? undefined : true,
    }))
  }

  function mutePullRequestById(itemId: string) {
    const itemState = localQueueState[itemId] ?? {}
    if (!canMuteLocalQueueItem(itemState)) return
    updateLocalItemState(itemId, () => ({ muted: true }))
  }

  async function markCaughtUpById(itemId: string) {
    setCaughtUpError(false)
    markSeenMutation.reset()
    await markSeenMutation.mutateAsync(itemId).catch(() => {
      setCaughtUpError(true)
    })
  }

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
  const reviewRequestCount = loadedItem.activityEvents.filter(
    (event) =>
      event.isNew && event.action.toLowerCase().includes("requested your review")
  ).length
  const loadedItemLocalState = localQueueState[loadedItem.id] ?? {}
  const bucketId = bucketIdForAvailableBucketId(
    bucketIdForLocalQueueItem(loadedItemLocalState, loadedItem.laneId),
    userBuckets
  )
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

  function movePullRequest(bucketId: UserBucketId) {
    movePullRequestToBucket(loadedItem.id, bucketId)
  }

  async function markCaughtUp() {
    await markCaughtUpById(loadedItem.id)
  }

  return (
    <div className="min-h-[760px] bg-background">
      <DetailHeader item={loadedItem} />
      <ContextBand
        item={loadedItem}
        bucketId={bucketId}
        userBuckets={userBuckets}
        newEventCount={newEvents.length}
        reviewRequestCount={reviewRequestCount}
        onMoveToBucket={movePullRequest}
      />
      <div className="grid grid-cols-1 gap-0 border-t border-border xl:grid-cols-[62fr_38fr]">
        <main className="min-w-0 px-7 py-6">
          <DescriptionPanel description={loadedItem.description} />
          <div className="mb-4 text-xs text-muted-foreground">
            Activity · newest first
          </div>
          <Timeline
            newEvents={newEvents}
            oldEvents={oldEvents}
            lastSeenAt={item.lastSeenAt}
            tone={detailToneForItem(loadedItem)}
          />
        </main>
        <DetailSideRail
          item={loadedItem}
          bucketId={bucketId}
          userBuckets={userBuckets}
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
          onMoveToBucket={movePullRequest}
          onCaughtUp={() => void markCaughtUp()}
        />
      </div>
    </div>
  )
}

function DescriptionPanel({ description }: { description?: string }) {
  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        PR description
      </div>
      {description ? (
        <MarkdownContent className="mt-3 max-w-4xl" source={description} />
      ) : (
        <div className="mt-3 text-sm leading-6 text-muted-foreground">
          No description provided.
        </div>
      )}
    </section>
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
    <div className="grid min-h-[760px] place-items-center bg-background px-6">
      <div className="max-w-sm rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {detail ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

function DetailHeader({ item }: { item: ReviewQueueItemView }) {
  const tone = detailToneForItem(item)

  return (
    <header className="grid grid-cols-1 gap-5 border-b border-border px-7 py-6 lg:grid-cols-[auto_1fr_auto]">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mt-1 h-8 w-fit justify-self-start text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        <Link to="/">
          <ArrowLeft className="h-4 w-4" />
          Inbox
        </Link>
      </Button>

      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">
          {item.repository} / #{item.number}
          <span className="mx-2 text-muted-foreground/40">·</span>
          opened by {item.authorLogin}
          <span className="mx-2 text-muted-foreground/40">·</span>
          {item.openedAt}
        </div>
        <h1 className="mt-2 text-3xl font-semibold leading-9 tracking-tight text-foreground">
          {item.title}
        </h1>
        <div className="mt-4 grid max-w-[860px] grid-cols-2 gap-2 md:grid-cols-4">
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
        <div className="rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-foreground">
          <span className={cn("mr-2 inline-block h-2 w-2 rounded-full", detailDotClasses[tone])} />
          {userReviewStanding(item.userLastReviewDecision)}
        </div>
        <Button asChild className="h-9">
          <a href={item.url} {...externalLinkProps}>
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
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        hot ? "border-amber-200 bg-amber-50 text-amber-800" : "border-border bg-muted/30"
      )}
    >
      <div className="text-xs text-muted-foreground/70">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-xs text-foreground",
          hot && "font-semibold text-foreground"
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ContextBand({
  item,
  bucketId,
  userBuckets,
  newEventCount,
  reviewRequestCount,
  onMoveToBucket,
}: {
  item: ReviewQueueItemView
  bucketId: UserBucketId
  userBuckets: UserBucketDefinition[]
  newEventCount: number
  reviewRequestCount: number
  onMoveToBucket: (bucketId: UserBucketId) => void
}) {
  const reReviewRequested = reviewRequestCount > 0
  const tone = detailToneForItem(item)
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
      value: String(reviewRequestCount),
      label: pluralize(reviewRequestCount, "review request"),
      show: reReviewRequested,
      hot: true,
    },
  ].filter((card) => card.show)
  const otherReviewerState =
    item.otherReviewers.length > 0
      ? item.otherReviewers
          .map((reviewer) => `${reviewer.login}: ${reviewDecisionLabel(reviewer.decision)}`)
          .join(" · ")
      : "none"
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
      <div className="rounded-md border border-border bg-card p-4 text-foreground">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <RotateCcw className="h-3.5 w-3.5" />
          <span className={cn("h-1.5 w-1.5 rounded-full", detailDotClasses[tone])} />
          New activity and current bucket
          <span className="opacity-45">·</span>
          {item.lastSeenAt}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <BucketMoveMenu
            bucketId={bucketId}
            userBuckets={userBuckets}
            onMoveToBucket={onMoveToBucket}
          />
          {newEventCount > 0 ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 text-xs font-medium text-sky-800">
              <Sparkles className="h-3.5 w-3.5" />
              {formatCount(newEventCount, "new event")}
            </span>
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-2 xl:grid-cols-5">
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
            value={authorActivity.length > 0 ? authorActivity.join(" · ") : "none"}
            hot={item.newCommitCount > 0 || item.newReplyCount > 0}
          />
          <ContextFact
            label="review request"
            value={reReviewRequested ? "again" : requestStateLabel(item)}
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
          <div className="mt-4 flex flex-wrap gap-2">
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
          <div className="mt-4 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm leading-5 text-foreground">
            No unseen review activity since your last visit.
          </div>
        )}
        <div className="mt-4 grid gap-2 text-sm leading-5 text-foreground">
          {item.activityEvents
            .filter((event) => event.isNew)
            .slice(0, 3)
            .map((event) => (
              <div key={event.id} className="flex gap-2">
                <span className={cn("mt-2 h-1.5 w-1.5 rounded-full", detailDotClasses[tone])} />
                <span>
                  <ActivityEventLine event={event} />
                  {event.detail ? ` - ${event.detail}` : ""}
                </span>
              </div>
            ))}
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
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
    <div className="min-w-0 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground/70">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-xs text-foreground",
          hot && "font-semibold text-foreground"
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
    <div
      className={cn(
        "inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground",
        hot && "border-amber-200 bg-amber-50 text-amber-800"
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {value}
      </span>
      <span>{label}</span>
    </div>
  )
}

function BucketMoveMenu({
  bucketId,
  userBuckets,
  onMoveToBucket,
  fullWidth,
}: {
  bucketId: UserBucketId
  userBuckets: UserBucketDefinition[]
  onMoveToBucket: (bucketId: UserBucketId) => void
  fullWidth?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 justify-start rounded-md text-xs",
            fullWidth && "w-full justify-center"
          )}
        >
          <ChevronsLeftRight className="h-3.5 w-3.5" />
          Bucket: {userBucketLabelFromId(userBuckets, bucketId)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48 rounded-lg">
        <DropdownMenuLabel>Move to bucket</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {userBuckets.map((bucket) => {
          const tone = detailBucketToneClasses[bucket.id] ?? "quiet"
          return (
            <DropdownMenuItem
              key={bucket.id}
              disabled={bucket.id === bucketId}
              onClick={() => onMoveToBucket(bucket.id)}
            >
              <span className={cn("h-2 w-2 rounded-full", detailDotClasses[tone])} />
              {bucket.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Timeline({
  newEvents,
  oldEvents,
  lastSeenAt,
  tone,
}: {
  newEvents: ActivityEventView[]
  oldEvents: ActivityEventView[]
  lastSeenAt: string
  tone: DetailTone
}) {
  return (
    <div className="relative">
      <div className="absolute top-2 bottom-2 left-[7px] w-px bg-border" />
      <div className="space-y-5">
        {newEvents.map((event) => (
          <TimelineItem key={event.id} event={event} isNew tone={tone} />
        ))}
        {newEvents.length > 0 && (
          <div className="relative grid gap-2 py-1 pl-7 sm:flex sm:items-center sm:gap-3">
            <span className="hidden h-px flex-1 bg-border sm:block" />
            <span className="text-xs leading-5 text-foreground sm:leading-none">
              <span className="sm:hidden">New since last look · {lastSeenAt}</span>
              <span className="hidden sm:inline">
                everything above is new since you last looked · {lastSeenAt}
              </span>
            </span>
            <span className="hidden h-px flex-1 bg-border sm:block" />
          </div>
        )}
        {oldEvents.map((event) => (
          <TimelineItem key={event.id} event={event} tone={tone} />
        ))}
      </div>
    </div>
  )
}

function TimelineItem({
  event,
  isNew,
  tone,
}: {
  event: ActivityEventView
  isNew?: boolean
  tone: DetailTone
}) {
  return (
    <div className="relative grid grid-cols-1 gap-1 pl-7 sm:grid-cols-[112px_1fr] sm:gap-5">
      <span
        className={cn(
          "absolute top-1.5 left-0 h-3.5 w-3.5 rounded-full border border-border bg-background",
          isNew && cn("border-transparent", detailDotClasses[tone])
        )}
      />
      <div className="text-xs text-muted-foreground/70">{event.occurredAt}</div>
      <div>
        <div className="text-sm leading-5 text-foreground">
          <ActivityEventLine event={event} />
        </div>
        {event.detail ? (
          <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-5 text-muted-foreground">
            {event.detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DetailSideRail({
  item,
  bucketId,
  userBuckets,
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
  onMoveToBucket,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  bucketId: UserBucketId
  userBuckets: UserBucketDefinition[]
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
  onMoveToBucket: (bucketId: UserBucketId) => void
  onCaughtUp: () => void
}) {
  const canMarkCaughtUp = canMarkReviewItemCaughtUp(item, isMarkingSeen)

  return (
    <aside className="border-t border-border bg-card px-5 py-6 xl:border-l xl:border-t-0">
      <RailCard title="Catch up">
        <div className="grid gap-2">
          {caughtUpError ? (
            <div className="rounded-md border border-foreground/30 bg-foreground/10 px-3 py-2 text-xs leading-5 text-foreground">
              Could not save caught-up state. Try again.
            </div>
          ) : null}
          <Button asChild className="h-9 justify-center">
            <a href={item.url} {...externalLinkProps}>
              {newEventCount > 0
                ? `Review ${formatCount(newEventCount, "new event")}`
                : "Review in GitHub"}
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <BucketMoveMenu
            bucketId={bucketId}
            userBuckets={userBuckets}
            onMoveToBucket={onMoveToBucket}
            fullWidth
          />
          <Button
            type="button"
            variant="outline"
            disabled={!canMarkCaughtUp}
            onClick={onCaughtUp}
            className="h-9 justify-center"
          >
            <Check className="h-4 w-4" />
            {isMarkingSeen
              ? "Saving"
              : newEventCount === 0
                ? "All caught up"
                : "Mark caught up"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isMuted}
              onClick={isSnoozed ? onRestore : onSnooze}
              className="h-9 justify-center"
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
              className="h-9 justify-center"
            >
              <Pin className="h-4 w-4" />
              {isPinned ? "Unpin" : "Pin"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isSnoozed}
              onClick={isMuted ? onRestore : onMute}
              className="col-span-2 h-9 justify-center"
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
          label="attention"
          value={detailAttentionLabel(item)}
        />
      </RailCard>
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
    <section className="mb-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="mb-3 text-xs text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  )
}

function RailKeyValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">{value}</span>
      </div>
      <Separator className="bg-border last:hidden" />
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

function detailToneForItem(item: ReviewQueueItemView): DetailTone {
  if (item.laneId === "updated_since_review") return "changed"
  if (item.waitingOn === "you") return "hot"
  if (item.waitingOn === "author") return "waiting"
  if (item.laneId === "approved") return "success"
  return "quiet"
}

function bucketIdForAvailableBucketId(
  bucketId: UserBucketId,
  userBuckets: UserBucketDefinition[]
): UserBucketId {
  return userBuckets.some((bucket) => bucket.id === bucketId)
    ? bucketId
    : userBuckets[0]?.id ?? bucketId
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
