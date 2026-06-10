import { Link, useParams } from "@tanstack/react-router"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  BellOff,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  FileText,
  GitCompareArrows,
  MessagesSquare,
  Pin,
  RotateCcw,
  ShieldAlert,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ActivityEventLine } from "@/components/ActivityEventLine"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { BoardItemNotes } from "@/components/BoardItemNotes"
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
import {
  getBoardState,
  getPullRequest,
  markPullRequestSeen,
  saveBoardState,
} from "@/api"
import { formatCount } from "@/lib/copy"
import { cn, externalLinkProps } from "@/lib/utils"
import {
  canMarkReviewItemCaughtUp,
  toReviewQueueItemView,
  type ActivityEventView,
  type ReviewQueueItemView,
  type SinceLastReviewView,
} from "@/reviewer/view-model"
import {
  bucketIdForLocalQueueItem,
  canMuteLocalQueueItem,
  canPinLocalQueueItem,
  canSnoozeLocalQueueItem,
  hasLocalQueueState,
  defaultUserBuckets,
  createEmptyUserBucketItemOrder,
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
  waiting: "border-violet-200 bg-violet-50 text-violet-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  quiet: "border-border bg-muted/40 text-muted-foreground",
}

const detailDotClasses: Record<DetailTone, string> = {
  hot: "bg-amber-500",
  changed: "bg-sky-500",
  waiting: "bg-violet-500",
  success: "bg-emerald-500",
  quiet: "bg-slate-400",
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
    useState<LocalQueueStateByPullRequestId>({})
  const [userBuckets, setUserBuckets] =
    useState<UserBucketDefinition[]>(defaultUserBuckets)
  const [userBucketItemOrder, setUserBucketItemOrder] = useState(() =>
    createEmptyUserBucketItemOrder()
  )
  const [bucketColumnWidths, setBucketColumnWidths] = useState<
    Record<string, number>
  >({})
  const [hasHydratedBoardState, setHasHydratedBoardState] = useState(false)
  const detailQuery = useQuery({
    queryKey: ["pull-request", pullRequestId],
    queryFn: () => getPullRequest(pullRequestId),
  })
  const boardStateQuery = useQuery({
    queryKey: ["board-state"],
    queryFn: getBoardState,
  })
  const saveBoardStateMutation = useMutation({
    mutationFn: saveBoardState,
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
    if (!boardStateQuery.data) return

    setUserBuckets(boardStateQuery.data.buckets)
    setLocalQueueState(boardStateQuery.data.localQueueState)
    setUserBucketItemOrder(boardStateQuery.data.userBucketItemOrder)
    setBucketColumnWidths(boardStateQuery.data.bucketColumnWidths)
    setHasHydratedBoardState(true)
  }, [boardStateQuery.data])

  useEffect(() => {
    if (!hasHydratedBoardState) return

    saveBoardStateMutation.mutate({
      buckets: userBuckets,
      localQueueState,
      userBucketItemOrder,
      bucketColumnWidths,
    })
  }, [
    bucketColumnWidths,
    hasHydratedBoardState,
    localQueueState,
    userBucketItemOrder,
    userBuckets,
  ])

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
    updateLocalItemState(itemId, (current) => ({
      ...current,
      muted: true,
    }))
  }

  function updatePullRequestNotes(itemId: string, notes: string) {
    updateLocalItemState(itemId, (current) => ({
      ...current,
      notes: notes.trim() ? notes : undefined,
    }))
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
        detail={
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "The local desktop cache did not return this reviewer pull request."
        }
        retryLabel={detailQuery.isFetching ? "Retrying" : "Retry"}
        retryDisabled={detailQuery.isFetching}
        onRetry={() => void detailQuery.refetch()}
      />
    )
  }

  const loadedItem = item
  const newEvents = loadedItem.activityEvents.filter((event) => event.isNew)
  const oldEvents = loadedItem.activityEvents.filter((event) => !event.isNew)
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

  function updateNotes(notes: string) {
    updatePullRequestNotes(loadedItem.id, notes)
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
      <div className="grid grid-cols-1 gap-0 border-t border-border xl:grid-cols-[62fr_38fr]">
        <main className="min-w-0 px-7 py-6">
          <DescriptionPanel description={loadedItem.description} />
          <BoardItemNotes
            value={loadedItemLocalState.notes ?? ""}
            onSave={updateNotes}
            className="mb-6"
          />
          <SinceLastReviewPanel view={loadedItem.sinceLastReview} />
          <ThreadLedgerPanel item={loadedItem} />
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
  if (!description) {
    return (
      <div className="mb-6 flex items-center gap-2 text-sm leading-6 text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        No description provided.
      </div>
    )
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        PR description
      </div>
      <MarkdownContent className="mt-3 max-w-4xl" source={description} />
    </section>
  )
}

function SinceLastReviewPanel({ view }: { view?: SinceLastReviewView }) {
  if (!view) return null

  const action =
    view.decision === "approved"
      ? "approved"
      : view.decision === "changes_requested"
        ? "requested changes"
        : "commented"
  const facts: string[] = []
  if (view.replyCount > 0) {
    facts.push(`${formatCount(view.replyCount, "reply", "replies")} from others`)
  }
  if (view.threadsResolvedCount > 0) {
    facts.push(`${formatCount(view.threadsResolvedCount, "thread")} resolved`)
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <GitCompareArrows className="h-3.5 w-3.5" />
        Since your last review · you {action} {view.reviewedAt}
      </div>
      <ul className="mt-3 space-y-2 text-sm leading-5 text-foreground">
        {view.commits.map((commit) => (
          <li key={commit.id} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            <span>
              {commit.title}
              <span className="text-muted-foreground"> · {commit.occurredAt}</span>
            </span>
          </li>
        ))}
        {view.commits.length === 0 && view.compareUrl ? (
          <li className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            <span>New commits were pushed</span>
          </li>
        ) : null}
        {facts.map((fact) => (
          <li key={fact} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            <span>{fact}</span>
          </li>
        ))}
      </ul>
      {view.compareUrl ? (
        <Button asChild variant="outline" className="mt-4 h-8 rounded-md text-xs">
          <a href={view.compareUrl} {...externalLinkProps}>
            View what changed since your review
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      ) : null}
    </section>
  )
}

function ThreadLedgerPanel({ item }: { item: ReviewQueueItemView }) {
  if (item.totalThreadCount === 0) return null

  const unresolvedThreads = item.reviewThreads.filter(
    (thread) => thread.status === "unresolved"
  )
  const resolvedCount = item.totalThreadCount - unresolvedThreads.length
  const awaitingCount = unresolvedThreads.filter(
    (thread) => thread.awaitingYourReply
  ).length

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessagesSquare className="h-3.5 w-3.5" />
        Threads · {item.unresolvedThreadCount} of {item.totalThreadCount}{" "}
        unresolved
        {awaitingCount > 0 ? ` · ${awaitingCount} awaiting your reply` : ""}
      </div>
      <div className="mt-3 space-y-2">
        {unresolvedThreads.map((thread) => (
          <div
            key={thread.id}
            className="rounded-md border border-border bg-muted/30 p-3"
          >
            <div className="text-sm leading-5 text-foreground">
              {thread.excerpt}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  thread.awaitingYourReply && "font-medium text-foreground"
                )}
              >
                {thread.awaitingYourReply
                  ? thread.lastActorLogin
                    ? `${thread.lastActorLogin} replied · awaiting your reply`
                    : "awaiting your reply"
                  : "you replied last"}
              </span>
              {thread.isOutdated ? (
                <span className="rounded-full border border-border bg-muted/40 px-1.5 py-[1px]">
                  outdated by new commits
                </span>
              ) : null}
            </div>
          </div>
        ))}
        {resolvedCount > 0 ? (
          <div className="text-xs text-muted-foreground/70">
            + {formatCount(resolvedCount, "resolved thread")}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function DetailStatusPanel({
  title,
  detail,
  retryLabel,
  retryDisabled = false,
  onRetry,
}: {
  title: string
  detail?: string
  retryLabel?: string
  retryDisabled?: boolean
  onRetry?: () => void
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
        {onRetry ? (
          <Button
            className="mt-4 rounded-md"
            disabled={retryDisabled}
            type="button"
            variant="outline"
            onClick={onRetry}
          >
            <RotateCcw className={cn("h-4 w-4", retryDisabled && "animate-spin")} />
            {retryLabel ?? "Retry"}
          </Button>
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {item.repository} / #{item.number}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="flex items-center gap-1.5">
            opened by
            <AuthorAvatar
              login={item.authorLogin}
              avatarUrl={item.authorAvatarUrl}
              className="h-4 w-4 text-[8px]"
            />
            {item.authorLogin}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{item.openedAt}</span>
        </div>
        <h1 className="mt-2 text-3xl font-semibold leading-9 tracking-tight text-foreground">
          {item.title}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
              waitingChipClasses(item)
            )}
          >
            {detailQueueLabel(item)} · {item.waitingAge}
          </span>
          {item.approvalStale ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
                detailToneClasses.hot
              )}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              Approved, then the author pushed
            </span>
          ) : null}
          {item.unseenEventCount > 0 ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
                detailToneClasses.changed
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {formatCount(item.unseenEventCount, "unseen event")} since{" "}
              {item.lastSeenAt}
            </span>
          ) : null}
          {item.totalThreadCount > 0 ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-muted-foreground",
                item.unresolvedThreadCount > 0 &&
                  "font-medium text-foreground"
              )}
            >
              {item.unresolvedThreadCount} of{" "}
              {formatCount(item.totalThreadCount, "thread")} unresolved
            </span>
          ) : null}
          <span className="text-muted-foreground">
            Updated {item.updatedAt}
          </span>
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
          aria-label={`Move to bucket, currently ${userBucketLabelFromId(userBuckets, bucketId)}`}
          className={cn(
            "h-9 justify-between rounded-md text-xs",
            fullWidth && "w-full"
          )}
        >
          <span className="font-normal text-muted-foreground">
            Move to bucket
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            {userBucketLabelFromId(userBuckets, bucketId)}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
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
            <div className="flex items-center justify-between gap-3 rounded-md border border-foreground/30 bg-foreground/10 px-3 py-2 text-xs leading-5 text-foreground">
              <span>Could not save caught-up state.</span>
              <Button
                className="h-7 rounded-md px-2 text-xs"
                disabled={isMarkingSeen}
                type="button"
                variant="outline"
                onClick={onCaughtUp}
              >
                <RotateCcw className={cn("h-3.5 w-3.5", isMarkingSeen && "animate-spin")} />
                Retry
              </Button>
            </div>
          ) : null}
          <Button asChild className="h-9 justify-center">
            <a href={item.url} {...externalLinkProps}>
              {newEventCount > 0
                ? `Review in GitHub · ${formatCount(newEventCount, "new event")}`
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

      <RailCard title="Why this needs your attention">
        <p className="text-sm leading-5 text-foreground">{item.reason}</p>
        {item.evidence.length > 0 ? (
          <ul className="mt-3 space-y-2 border-t border-border pt-3">
            {item.evidence.map((line) => (
              <li key={line.id} className="flex gap-2 text-xs leading-5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <span>
                  <span className="text-foreground">{line.label}</span>
                  {line.occurredAt ? (
                    <span className="text-muted-foreground"> · {line.occurredAt}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </RailCard>

      <RailCard title="Where it stands">
        <RailKeyValue
          label="your review"
          value={reviewDecisionLabel(item.userLastReviewDecision)}
        />
        {item.otherReviewers.map((reviewer) => (
          <RailKeyValue
            key={reviewer.login}
            label={
              <span className="flex items-center gap-1.5">
                <AuthorAvatar
                  login={reviewer.login}
                  avatarUrl={reviewer.avatarUrl}
                  className="h-4 w-4 text-[8px]"
                />
                {reviewer.login}
              </span>
            }
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
        {item.reviewRounds > 0 ? (
          <RailKeyValue
            label="rounds of changes"
            value={
              item.reviewRounds > 2
                ? `${item.reviewRounds} · unusually high`
                : `${item.reviewRounds}`
            }
          />
        ) : null}
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

function RailKeyValue({ label, value }: { label: ReactNode; value: string }) {
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

function waitingChipClasses(item: ReviewQueueItemView): string {
  if (item.waitingOn === "none") {
    return "border-border bg-muted/30 text-muted-foreground"
  }
  if (item.waitingUrgency === "overdue") {
    return "border-rose-200 bg-rose-50 text-rose-800"
  }
  if (item.waitingOn === "you" || item.waitingUrgency === "elevated") {
    return detailToneClasses.hot
  }
  return "border-border bg-muted/30 text-muted-foreground"
}

function detailToneForItem(item: ReviewQueueItemView): DetailTone {
  if (item.laneId === "updated_since_review") return "changed"
  if (item.waitingOn === "you") return "hot"
  if (item.waitingOn === "author" && item.laneId === "waiting_on_author") {
    return "waiting"
  }
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


