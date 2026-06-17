import { Link, useParams } from "@tanstack/react-router"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react"
import { isAiModeActive } from "@/ai/ai-settings"
import type { PrBriefContent } from "@/ai/pr-brief"
import { Button } from "@/components/ui/button"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { BoardItemNotes } from "@/components/BoardItemNotes"
import { Separator } from "@/components/ui/separator"
import {
  generateAiPrBrief,
  getAiPrBrief,
  getAiSettings,
  getAttentionSettings,
  getPullRequest,
  getPullRequestNotes,
  markPullRequestSeen,
  savePullRequestNotes,
  type AiGenerated,
} from "@/api"
import { formatCount } from "@/lib/copy"
import { cn, externalLinkProps } from "@/lib/utils"
import {
  canMarkReviewItemCaughtUp,
  defaultAttentionThresholds,
  formatRelativeTime,
  toReviewQueueItemView,
  type ReviewQueueItemView,
  type ReviewThreadView,
  type SizeChipView,
} from "@/reviewer/view-model"
import type { ReviewDecision } from "@pr-tracker/core"

const reviewDecisionLabels: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes req.",
  commented: "commented",
}

export function PullRequestPage() {
  const { pullRequestId } = useParams({ from: "/pull-requests/$pullRequestId" })

  return <PullRequestDetailSurface pullRequestId={pullRequestId} />
}

export function PullRequestDetailSurface({
  pullRequestId,
  onRequestClose,
}: {
  pullRequestId: string
  onRequestClose?: () => void
}) {
  const queryClient = useQueryClient()
  const [caughtUpError, setCaughtUpError] = useState(false)
  const detailQuery = useQuery({
    queryKey: ["pull-request", pullRequestId],
    queryFn: () => getPullRequest(pullRequestId),
  })
  const attentionSettingsQuery = useQuery({
    queryKey: ["attention-settings"],
    queryFn: getAttentionSettings,
  })
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  })
  const notesQuery = useQuery({
    queryKey: ["pull-request-notes", pullRequestId],
    queryFn: () => getPullRequestNotes(pullRequestId),
  })
  const aiActive = isAiModeActive(aiSettingsQuery.data)
  const saveNotesMutation = useMutation({
    mutationFn: (notes: string) => savePullRequestNotes(pullRequestId, notes),
    onSuccess: (result) => {
      queryClient.setQueryData(["pull-request-notes", pullRequestId], result)
    },
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
        detail.viewer.id,
        attentionSettingsQuery.data ?? defaultAttentionThresholds
      )
    : undefined

  async function markCaughtUp(itemId: string) {
    setCaughtUpError(false)
    markSeenMutation.reset()
    await markSeenMutation.mutateAsync(itemId).catch(() => {
      setCaughtUpError(true)
    })
  }

  if (detailQuery.isLoading) {
    return <DetailLoadingSkeleton />
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
  const newEventCount = loadedItem.activityEvents.filter(
    (event) => event.isNew
  ).length

  return (
    <div className="min-h-[760px] bg-background">
      <DetailHeader item={loadedItem} onRequestClose={onRequestClose} />
      <div className="grid grid-cols-1 gap-0 border-t border-border xl:grid-cols-[62fr_38fr]">
        <main className="min-w-0 px-7 py-6">
          <AiBriefSection
            item={loadedItem}
            aiActive={aiActive}
            aiLoading={aiSettingsQuery.isLoading}
          />
          <BoardItemNotes
            value={notesQuery.data?.notes ?? ""}
            onSave={(notes) => saveNotesMutation.mutate(notes)}
            className="mb-6"
          />
        </main>
        <DetailSideRail
          item={loadedItem}
          newEventCount={newEventCount}
          isMarkingSeen={markSeenMutation.isPending}
          caughtUpError={caughtUpError}
          onCaughtUp={() => void markCaughtUp(loadedItem.id)}
        />
      </div>
    </div>
  )
}

/**
 * The AI region of the detail page. One consolidated brief fills every
 * section (your move, what this PR does, the conversation, what moved, what
 * is next). Nothing is generated until the reviewer clicks Generate; the
 * sections stay empty until then.
 */
function AiBriefSection({
  item,
  aiActive,
  aiLoading,
}: {
  item: ReviewQueueItemView
  aiActive: boolean
  aiLoading: boolean
}) {
  const queryClient = useQueryClient()
  const briefQuery = useQuery({
    queryKey: ["ai-pr-brief", item.id],
    queryFn: () => getAiPrBrief(item.id),
    enabled: aiActive,
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiPrBrief(item.id),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-pr-brief", item.id], result)
    },
  })
  const brief = briefQuery.data ?? undefined

  return (
    <>
      <YourMoveCard
        item={item}
        aiActive={aiActive}
        aiLoading={aiLoading}
        brief={brief}
        isLoadingCache={briefQuery.isLoading}
        isGenerating={generateMutation.isPending}
        error={generateMutation.error}
        onGenerate={() => generateMutation.mutate()}
      />
      {brief ? (
        <>
          <SinceYouLookedCard item={item} content={brief.content.sinceYouLooked} />
          <WhatsNextCard steps={brief.content.whatsNext} />
          <WhatThisDoesCard content={brief.content.whatThisDoes} />
          <ConversationCard item={item} content={brief.content.conversation} />
        </>
      ) : null}
    </>
  )
}

function YourMoveCard({
  item,
  aiActive,
  aiLoading,
  brief,
  isLoadingCache,
  isGenerating,
  error,
  onGenerate,
}: {
  item: ReviewQueueItemView
  aiActive: boolean
  aiLoading: boolean
  brief: AiGenerated<PrBriefContent> | undefined
  isLoadingCache: boolean
  isGenerating: boolean
  error: Error | null
  onGenerate: () => void
}) {
  const toneClass =
    item.waitingOn === "you"
      ? "border-rose-200 bg-rose-50/60"
      : item.waitingOn === "author"
        ? "border-sky-200 bg-sky-50/50"
        : "border-border bg-muted/30"

  return (
    <section className={cn("mb-6 rounded-md border p-4", toneClass)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Your move</h2>
          <span className="text-xs text-muted-foreground">
            why it&apos;s your turn
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              waitingChipClasses(item)
            )}
          >
            {detailQueueLabel(item)} · {item.waitingAge}
          </span>
          {brief ? (
            <Button
              className="h-7 rounded-md px-2 text-xs"
              disabled={isGenerating}
              type="button"
              variant="outline"
              onClick={onGenerate}
            >
              {isGenerating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Regenerate
            </Button>
          ) : null}
        </div>
      </div>

      {brief ? (
        <div className="mt-3">
          <p className="text-sm leading-6 text-foreground">
            {brief.content.yourMove}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              AI-generated · may be inaccurate
            </span>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span>
              Generated {formatRelativeTime(brief.generatedAt)} · {brief.model}
            </span>
            {brief.isStale ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-[1px] text-amber-800">
                This PR changed since the brief
              </span>
            ) : null}
          </div>
        </div>
      ) : aiLoading || isLoadingCache ? (
        <div className="mt-3 h-9 w-48 animate-pulse rounded-md bg-muted/60" />
      ) : !aiActive ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-5 text-muted-foreground">
            Turn on AI mode in Settings to generate a brief — whose turn it is,
            what this PR does, where the conversation stands, and what to do
            next.
          </p>
          <Button asChild variant="outline" className="h-8 rounded-md text-xs">
            <Link to="/settings">Open settings</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-5 text-muted-foreground">
            Generate a brief for this PR. Sends its metadata, diff, threads, and
            comments to your AI provider using your key — nothing is sent until
            you ask.
          </p>
          <Button
            className="h-8 rounded-md text-xs"
            disabled={isGenerating}
            type="button"
            onClick={onGenerate}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Generate AI brief
          </Button>
        </div>
      )}

      {error ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error.message}</span>
          <Button
            className="h-8 rounded-md px-2 text-xs"
            disabled={isGenerating}
            type="button"
            variant="outline"
            onClick={onGenerate}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function AiSectionCard({
  title,
  icon,
  tone = "plain",
  children,
}: {
  title: string
  icon?: ReactNode
  tone?: "plain" | "waiting"
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        "mb-6 rounded-md border p-4",
        tone === "waiting"
          ? "border-violet-200 bg-violet-50/40"
          : "border-border bg-card"
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {icon ?? <Sparkles className="h-3.5 w-3.5" />}
        {title}
        <span className="rounded-full border border-border bg-muted/40 px-1.5 py-[1px] font-normal">
          AI
        </span>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function SinceYouLookedCard({
  item,
  content,
}: {
  item: ReviewQueueItemView
  content: PrBriefContent["sinceYouLooked"]
}) {
  if (content.length === 0) return null

  const title = item.lastSeenAtIso
    ? `Since you last looked · ${item.lastSeenAt}`
    : "Since you last looked"

  return (
    <AiSectionCard title={title} tone="waiting">
      <ul className="space-y-3">
        {content.map((entry, index) => (
          <li
            key={`${entry.kind}-${index}`}
            className="grid grid-cols-[64px_1fr] gap-3"
          >
            <span className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
              <SinceKindIcon kind={entry.kind} />
              {entry.kind}
            </span>
            <div>
              <div className="text-sm leading-5 text-foreground">
                {entry.text}
              </div>
              {entry.detail ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {entry.detail}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </AiSectionCard>
  )
}

function SinceKindIcon({
  kind,
}: {
  kind: PrBriefContent["sinceYouLooked"][number]["kind"]
}) {
  if (kind === "commit") {
    return <GitCommitHorizontal className="h-3.5 w-3.5" />
  }
  if (kind === "check") {
    return <CheckCircle2 className="h-3.5 w-3.5" />
  }
  if (kind === "comment" || kind === "review" || kind === "thread") {
    return <MessageSquare className="h-3.5 w-3.5" />
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
}

function WhatsNextCard({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null

  return (
    <AiSectionCard title="What's next" icon={<Sparkles className="h-3.5 w-3.5" />}>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={`${index}-${step}`}
            className="flex gap-3 text-sm leading-5 text-foreground"
          >
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-xs font-medium text-muted-foreground">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </AiSectionCard>
  )
}

const changeTagClasses: Record<
  PrBriefContent["whatThisDoes"]["changes"][number]["tag"],
  string
> = {
  new: "border-emerald-200 bg-emerald-50 text-emerald-700",
  refactor: "border-sky-200 bg-sky-50 text-sky-700",
  fix: "border-amber-200 bg-amber-50 text-amber-800",
  test: "border-violet-200 bg-violet-50 text-violet-700",
  docs: "border-border bg-muted/50 text-muted-foreground",
  chore: "border-border bg-muted/50 text-muted-foreground",
}

function WhatThisDoesCard({
  content,
}: {
  content: PrBriefContent["whatThisDoes"]
}) {
  return (
    <AiSectionCard title="What this PR does">
      <p className="text-sm leading-6 text-foreground">{content.overview}</p>
      {content.changes.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm leading-6 text-foreground">
          {content.changes.map((change, index) => (
            <li
              key={`${change.tag}-${index}`}
              className="grid grid-cols-[64px_1fr] items-start gap-3"
            >
              <span
                className={cn(
                  "mt-[3px] inline-flex w-full items-center justify-center rounded-full border px-2 py-[2px] text-[11px] font-medium leading-4",
                  changeTagClasses[change.tag]
                )}
              >
                {change.tag}
              </span>
              <span>{change.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </AiSectionCard>
  )
}

function ConversationCard({
  item,
  content,
}: {
  item: ReviewQueueItemView
  content: PrBriefContent["conversation"]
}) {
  if (item.totalThreadCount === 0) return null

  const noteByFile = new Map(
    content.threads.map((thread) => [thread.file, thread.note])
  )
  const threads = item.reviewThreads.slice(0, 8)

  return (
    <AiSectionCard title="Conversation so far">
      {content.overview ? (
        <p className="text-sm leading-6 text-foreground">{content.overview}</p>
      ) : null}
      <div className={cn("space-y-2", content.overview && "mt-3")}>
        {threads.map((thread) => (
          <ConversationThread
            key={thread.id}
            thread={thread}
            note={noteByFile.get(thread.excerpt)}
          />
        ))}
        {item.totalThreadCount > threads.length ? (
          <div className="text-xs text-muted-foreground/70">
            + {formatCount(item.totalThreadCount - threads.length, "more thread")}
          </div>
        ) : null}
      </div>
    </AiSectionCard>
  )
}

function ConversationThread({
  thread,
  note,
}: {
  thread: ReviewThreadView
  note?: string
}) {
  const badge =
    thread.status === "resolved"
      ? {
          label: "resolved",
          className: "border-emerald-200 bg-emerald-50 text-emerald-700",
        }
      : thread.awaitingYourReply
        ? {
            label: "needs your reply",
            className: "border-amber-200 bg-amber-50 text-amber-800",
          }
        : {
            label: "awaiting author",
            className: "border-sky-200 bg-sky-50 text-sky-700",
          }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm leading-5 text-foreground">{thread.excerpt}</span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-[1px] text-[11px] font-medium leading-4",
            badge.className
          )}
        >
          {badge.label}
        </span>
      </div>
      {note ? (
        <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{note}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>
          {thread.lastActorLogin
            ? `${thread.lastActorLogin} replied last`
            : "no replies yet"}
        </span>
        {thread.isOutdated ? (
          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-[1px]">
            outdated by new commits
          </span>
        ) : null}
      </div>
    </div>
  )
}

function DetailLoadingSkeleton() {
  return (
    <div
      className="min-h-[760px] bg-background"
      aria-busy="true"
      aria-label="Loading pull request details"
    >
      <div className="border-b border-border bg-white px-6 py-5">
        <div className="mb-4 h-8 w-8 rounded-md bg-muted" />
        <div className="grid gap-3">
          <div className="h-4 w-32 rounded bg-muted/70" />
          <div className="h-7 max-w-2xl rounded bg-muted" />
          <div className="h-4 w-80 rounded bg-muted/70" />
        </div>
      </div>
      <div className="grid gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-4">
          {[0, 1, 2].map((section) => (
            <div key={section} className="rounded-md border border-border bg-white p-4">
              <div className="mb-4 h-4 w-36 rounded bg-muted" />
              <div className="grid gap-3">
                <div className="h-4 w-full rounded bg-muted/70" />
                <div className="h-4 w-5/6 rounded bg-muted/70" />
                <div className="h-4 w-2/3 rounded bg-muted/70" />
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-border bg-white p-4">
          <div className="mb-4 h-4 w-28 rounded bg-muted" />
          <div className="grid gap-3">
            <div className="h-8 rounded bg-muted/70" />
            <div className="h-8 rounded bg-muted/70" />
            <div className="h-8 rounded bg-muted/70" />
          </div>
        </div>
      </div>
    </div>
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

function DetailHeader({
  item,
  onRequestClose,
}: {
  item: ReviewQueueItemView
  onRequestClose?: () => void
}) {
  return (
    <header className="grid grid-cols-1 gap-5 border-b border-border px-7 py-6 lg:grid-cols-[auto_1fr_auto]">
      {onRequestClose ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Close pull request details"
          onClick={onRequestClose}
          className="mt-1 h-8 w-fit justify-self-start text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <X className="h-4 w-4" />
          Close
        </Button>
      ) : (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-fit justify-self-start text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <Link to="/">
            <ArrowLeft className="h-4 w-4" />
            Home
          </Link>
        </Button>
      )}

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
          <span>active {item.updatedAt}</span>
        </div>
        <h1 className="mt-2 text-3xl font-semibold leading-9 tracking-tight text-foreground">
          {item.title}
        </h1>
        <PullRequestLabels labels={item.labels} className="mt-4" />
      </div>

      <div className="flex min-w-[190px] flex-col items-stretch">
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

function DetailSideRail({
  item,
  newEventCount,
  isMarkingSeen,
  caughtUpError,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  newEventCount: number
  isMarkingSeen: boolean
  caughtUpError: boolean
  onCaughtUp: () => void
}) {
  const canMarkCaughtUp = canMarkReviewItemCaughtUp(item, isMarkingSeen)
  const latestPushes = item.activityEvents
    .filter((event) => event.type === "commit")
    .slice(0, 3)

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
        </div>
      </RailCard>

      <RailCard title="Straight from GitHub">
        <RailKeyValue
          label="opened"
          value={
            <span className="inline-flex items-center gap-1.5">
              {item.openedAt} by
              <PersonInline
                login={item.authorLogin}
                avatarUrl={item.authorAvatarUrl}
              />
            </span>
          }
        />
        {item.size ? (
          <RailKeyValue label="size" value={detailSizeText(item.size)} />
        ) : null}
        {item.checks ? (
          <RailKeyValue
            label="checks"
            value={
              <span
                className={cn(
                  "font-medium",
                  item.checks.state === "failure"
                    ? "text-destructive"
                    : item.checks.state === "success"
                      ? "text-emerald-700"
                      : "text-muted-foreground"
                )}
              >
                {item.checks.state}
                {item.checks.totalCount
                  ? ` · ${formatCount(item.checks.totalCount, "check")}`
                  : ""}
              </span>
            }
          />
        ) : null}
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

      {latestPushes.length > 0 ? (
        <RailCard title="Latest pushes">
          <ul className="space-y-3">
            {latestPushes.map((event) => (
              <li key={event.id} className="flex gap-2 text-xs leading-5">
                <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="text-foreground">{event.action}</span>
                  <span className="text-muted-foreground"> · {event.occurredAt}</span>
                </span>
              </li>
            ))}
          </ul>
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
    <section className="mb-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  )
}

function RailKeyValue({ label, value }: { label: ReactNode; value: ReactNode }) {
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

function PullRequestLabels({
  labels,
  className,
}: {
  labels: ReviewQueueItemView["labels"]
  className?: string
}) {
  if (labels.length === 0) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {labels.map((label) => (
        <span
          key={label.name}
          title={label.description ? `${label.name}: ${label.description}` : label.name}
          aria-label={
            label.description
              ? `${label.name}: ${label.description}`
              : `GitHub label: ${label.name}`
          }
          className={cn(
            "inline-flex max-w-full items-center rounded-full border px-2 py-[1px] text-[11px] font-medium leading-4",
            !label.color && "border-border bg-muted text-muted-foreground"
          )}
          style={githubLabelStyle(label.color)}
        >
          <span className="truncate">{label.name}</span>
        </span>
      ))}
    </div>
  )
}

function PersonInline({
  login,
  avatarUrl,
}: {
  login: string
  avatarUrl?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <AuthorAvatar login={login} avatarUrl={avatarUrl} className="h-4 w-4 text-[8px]" />
      {login}
    </span>
  )
}

function githubLabelStyle(color: string | undefined): CSSProperties | undefined {
  if (!color) return undefined

  const normalized = color.replace(/^#/, "")
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return undefined

  const backgroundColor = `#${normalized}`
  return {
    backgroundColor,
    borderColor: backgroundColor,
    color: githubLabelTextColor(normalized),
  }
}

function githubLabelTextColor(color: string): string {
  const red = Number.parseInt(color.slice(0, 2), 16)
  const green = Number.parseInt(color.slice(2, 4), 16)
  const blue = Number.parseInt(color.slice(4, 6), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return luminance > 0.58 ? "#24292f" : "#ffffff"
}

function reviewDecisionLabel(decision: ReviewDecision | "pending"): string {
  return decision === "pending" ? "pending" : reviewDecisionLabels[decision]
}

function detailSizeText(size: SizeChipView): string {
  const fileText =
    size.fileCount !== undefined ? ` · ${formatCount(size.fileCount, "file")}` : ""
  return `+${size.additions} / −${size.deletions}${fileText}`
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
    return "border-amber-200 bg-amber-50 text-amber-800"
  }
  return "border-border bg-muted/30 text-muted-foreground"
}
