import { useMemo, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react"
import {
  generateAiDashboard,
  getAiDashboard,
  getAiSettings,
  getGithubSettingsStatus,
  visitInsights,
  type AiGenerated,
} from "@/api"
import {
  buildAiDashboardInput,
  type AiDashboardContent,
} from "@/ai/ai-dashboard"
import { isAiModeActive } from "@/ai/ai-settings"
import { useGithubSync } from "@/app/use-github-sync"
import { useReviewerInsights } from "@/app/use-reviewer-insights"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { Button } from "@/components/ui/button"
import { githubLabelStyle } from "@/lib/label-color"
import { cn, externalLinkProps } from "@/lib/utils"
import {
  formatRelativeTime,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import { formatSyncStatusLabel } from "./inbox-helpers"

type DashboardFilter = "all" | "your-move" | "waiting" | "stalled"

export function AiDashboardPage() {
  const githubSync = useGithubSync()
  const githubSettingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  })
  const visitQuery = useQuery({
    queryKey: ["insights-visit"],
    queryFn: visitInsights,
    staleTime: Infinity,
  })
  const { allItems } = useReviewerInsights({
    previousVisitAt: visitQuery.data?.previousVisitAt,
    scope: "board",
  })
  const aiActive = isAiModeActive(aiSettingsQuery.data)
  const sinceVisitLabel = visitQuery.data?.previousVisitAt
    ? formatRelativeTime(visitQuery.data.previousVisitAt)
    : undefined
  const syncLabel = formatSyncStatusLabel({
    isSyncing: githubSync.isSyncing,
    lastSyncedAt: githubSync.lastSyncedAt,
    tokenConfigured: Boolean(githubSettingsQuery.data?.tokenConfigured),
  })

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
        {aiSettingsQuery.isLoading ? null : !aiActive ? (
          <AiModeOffCard />
        ) : !allItems || visitQuery.isLoading ? (
          <div
            aria-busy="true"
            className="h-32 animate-pulse rounded-md border border-border bg-muted/40"
          />
        ) : (
          <AiDashboardBody
            allItems={allItems}
            sinceVisitLabel={sinceVisitLabel}
            syncLabel={syncLabel}
            isSyncing={githubSync.isSyncing}
            onSyncNow={githubSync.syncNow}
          />
        )}
      </div>
    </div>
  )
}

function AiModeOffCard() {
  return (
    <div className="grid place-items-center rounded-md border border-border bg-card px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        AI mode is off
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        Enable AI mode in Settings to generate a dashboard over the applied
        board. Nothing is sent anywhere until you generate it.
      </p>
      <Button asChild className="mt-5 rounded-md" variant="outline">
        <Link to="/settings">Open settings</Link>
      </Button>
    </div>
  )
}

function AiDashboardBody({
  allItems,
  sinceVisitLabel,
  syncLabel,
  isSyncing,
  onSyncNow,
}: {
  allItems: ReviewQueueItemView[]
  sinceVisitLabel?: string
  syncLabel: string
  isSyncing: boolean
  onSyncNow: () => void
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<DashboardFilter>("all")
  const input = useMemo(
    () => buildAiDashboardInput(allItems, { sinceVisitLabel }),
    [allItems, sinceVisitLabel]
  )
  const inputKey = useMemo(() => JSON.stringify(input), [input])
  const itemById = useMemo(
    () => new Map(allItems.map((item) => [item.id, item])),
    [allItems]
  )
  const dashboardQuery = useQuery({
    queryKey: ["ai-dashboard", inputKey],
    queryFn: () => getAiDashboard(input),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiDashboard(input),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-dashboard", inputKey], result)
    },
  })
  const result = dashboardQuery.data ?? undefined
  const openItems = input.items.flatMap((entry) => {
    const item = itemById.get(entry.id)
    return item ? [item] : []
  })
  const filteredItems = openItems.filter((item) => matchesFilter(item, filter))
  const cardById = new Map(
    (result?.content.cards ?? []).map((card) => [card.pullRequestId, card])
  )
  const canGenerate = input.items.length > 0 && !generateMutation.isPending

  if (input.items.length === 0) {
    return (
      <>
        <DashboardHeader
          result={result}
          isLoadingCache={dashboardQuery.isLoading}
          isGenerating={generateMutation.isPending}
          canGenerate={false}
          error={generateMutation.error}
          syncLabel={syncLabel}
          isSyncing={isSyncing}
          onSyncNow={onSyncNow}
          onGenerate={() => generateMutation.mutate()}
        />
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing to brief - the applied board filter has no open pull
          requests right now.
        </div>
      </>
    )
  }

  return (
    <>
      <DashboardHeader
        result={result}
        isLoadingCache={dashboardQuery.isLoading}
        isGenerating={generateMutation.isPending}
        canGenerate={canGenerate}
        error={generateMutation.error}
        syncLabel={syncLabel}
        isSyncing={isSyncing}
        onSyncNow={onSyncNow}
        onGenerate={() => generateMutation.mutate()}
      />

      <div className="grid grid-cols-2 gap-4">
        <SummaryPanel
          title="Where things stand"
          content={result?.content.queueSummary}
          fallback={buildQueueFallback(input)}
        />
        <SummaryPanel
          title={
            sinceVisitLabel
              ? `Since your last visit · ${sinceVisitLabel}`
              : "Since your last visit"
          }
          content={result?.content.sinceLastVisit}
          fallback={buildSinceFallback(input, openItems)}
        />
      </div>

      <FilterBar
        active={filter}
        metrics={input.metrics}
        onChange={setFilter}
      />

      <div className="flex flex-col gap-3">
        {filteredItems.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No pull requests match this dashboard filter.
          </div>
        ) : (
          filteredItems.map((item) => (
            <PullRequestDashboardCard
              key={item.id}
              item={item}
              generated={cardById.get(item.id)}
            />
          ))
        )}
      </div>
    </>
  )
}

function DashboardHeader({
  result,
  isLoadingCache,
  isGenerating,
  canGenerate,
  error,
  syncLabel,
  isSyncing,
  onSyncNow,
  onGenerate,
}: {
  result: AiGenerated<AiDashboardContent> | undefined
  isLoadingCache: boolean
  isGenerating: boolean
  canGenerate: boolean
  error: Error | null
  syncLabel: string
  isSyncing: boolean
  onSyncNow: () => void
  onGenerate: () => void
}) {
  return (
    <header className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              AI Dashboard
            </h1>
            <span className="text-xs text-muted-foreground">· {syncLabel}</span>
            <button
              type="button"
              aria-label="Sync with GitHub now"
              title="Sync with GitHub now"
              disabled={isSyncing}
              onClick={onSyncNow}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
            >
              <RotateCcw
                className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")}
              />
            </button>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            Pure turn-tracking over the applied board: what changed, whose
            court each review is in, what happens next, and whether anything
            is stalled. The AI writes text only from board-scoped facts.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {result ? (
              <>
                <span>
                  Generated {formatRelativeTime(result.generatedAt)} ·{" "}
                  {result.model}
                </span>
                {result.isStale ? (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-[1px] text-amber-800">
                    The board changed since this was generated
                  </span>
                ) : null}
              </>
            ) : (
              <span>Nothing is sent to your AI provider until you generate.</span>
            )}
          </div>
          {error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error.message}
            </div>
          ) : null}
        </div>

        <Button
          className="h-8 shrink-0 rounded-md text-xs"
          disabled={!canGenerate || isLoadingCache}
          type="button"
          onClick={onGenerate}
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : result ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {result ? "Regenerate" : "Generate"}
        </Button>
      </div>
    </header>
  )
}

function SummaryPanel({
  title,
  content,
  fallback,
}: {
  title: string
  content:
    | AiDashboardContent["queueSummary"]
    | AiDashboardContent["sinceLastVisit"]
    | undefined
  fallback: { body: string; bullets: Array<{ tone?: string; text: string }> }
}) {
  const bullets =
    content?.bullets.map((bullet) =>
      typeof bullet === "string" ? { text: bullet } : bullet
    ) ?? fallback.bullets

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2 border-b border-border pb-2.5 text-sm font-semibold text-foreground">
        <Sparkles className="h-4 w-4 text-violet-500" />
        {title}
      </div>
      <p className="text-sm leading-6 text-foreground">
        {content?.body ?? fallback.body}
      </p>
      {bullets.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm leading-5 text-muted-foreground">
          {bullets.map((bullet, index) => (
            <SummaryBullet key={`${bullet.text}-${index}`} bullet={bullet} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function SummaryBullet({
  bullet,
}: {
  bullet:
    | { tone: "urgent" | "stalled" | "quick_win" | "info"; text: string }
    | { text: string }
}) {
  const tone = "tone" in bullet ? bullet.tone : undefined

  return (
    <li className="flex gap-2">
      <span
        className={cn(
          "mt-2 h-1.5 w-1.5 shrink-0 rounded-full",
          tone === "urgent"
            ? "bg-rose-500"
            : tone === "stalled"
              ? "bg-amber-500"
              : tone === "quick_win"
                ? "bg-emerald-500"
                : "bg-muted-foreground/50"
        )}
      />
      <span>{bullet.text}</span>
    </li>
  )
}

function FilterBar({
  active,
  metrics,
  onChange,
}: {
  active: DashboardFilter
  metrics: ReturnType<typeof buildAiDashboardInput>["metrics"]
  onChange: (filter: DashboardFilter) => void
}) {
  const filters: Array<{ id: DashboardFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: metrics.openReviewCount },
    { id: "your-move", label: "Your move", count: metrics.yourMoveCount },
    {
      id: "waiting",
      label: "Waiting on author",
      count: metrics.waitingOnAuthorCount,
    },
    { id: "stalled", label: "Stalled", count: metrics.stalledCount },
  ]

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <span className="mr-1 text-xs text-muted-foreground">Showing</span>
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          onClick={() => onChange(filter.id)}
          className={
            active === filter.id
              ? "inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-semibold text-background"
              : "inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-muted"
          }
        >
          {filter.label} · {filter.count}
        </button>
      ))}
    </div>
  )
}

function PullRequestDashboardCard({
  item,
  generated,
}: {
  item: ReviewQueueItemView
  generated: AiDashboardContent["cards"][number] | undefined
}) {
  const laneTone =
    item.waitingOn === "you"
      ? "border-l-rose-500"
      : item.waitingOn === "author"
        ? "border-l-sky-500"
        : "border-l-muted-foreground/30"
  const summary = generated?.summary ?? item.reason
  const sinceYouLooked =
    generated?.sinceYouLooked ?? deterministicSinceYouLooked(item)
  const nextAction = generated?.nextAction ?? deterministicNextAction(item)

  return (
    <section
      className={cn(
        "rounded-md border border-l-4 border-border bg-card p-5",
        laneTone
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={`Opened by ${item.authorLogin}`}
            className="flex items-center"
          >
            <AuthorAvatar
              className="h-6 w-6"
              login={item.authorLogin}
              avatarUrl={item.authorAvatarUrl}
            />
          </span>
          <LaneTag waitingOn={item.waitingOn} />
          {item.waitingUrgency !== "none" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-[2px] text-xs font-medium text-amber-800">
              <Clock className="h-3 w-3" />
              {item.waitingUrgency === "overdue" ? "stalled" : "aging"}{" "}
              {item.waitingAge} · on {item.waitingOn}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">
            {item.repository} #{item.number}
          </span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span className="whitespace-nowrap">active {item.updatedAt}</span>
          <a
            href={item.url}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Open ${item.repository} #${item.number} on GitHub`}
            title="Open on GitHub"
            {...externalLinkProps}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      <Link
        to="/pull-requests/$pullRequestId"
        params={{ pullRequestId: item.id }}
        className="mt-3 block text-base font-semibold leading-snug text-foreground hover:underline"
      >
        {item.title}
      </Link>

      <p className="mt-3 text-sm leading-6 text-foreground">{summary}</p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <TextInset title="Since you looked" accent>
          {sinceYouLooked}
        </TextInset>
        <TextInset title="What's next">{nextAction}</TextInset>
      </div>

      <CardFactRow item={item} />
    </section>
  )
}

function LaneTag({
  waitingOn,
}: {
  waitingOn: ReviewQueueItemView["waitingOn"]
}) {
  const config =
    waitingOn === "you"
      ? {
          label: "Your move",
          className: "border-rose-200 bg-rose-50 text-rose-700",
        }
      : waitingOn === "author"
        ? {
            label: "Waiting on author",
            className: "border-sky-200 bg-sky-50 text-sky-700",
          }
        : undefined

  if (!config) return null

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-[3px] text-xs font-semibold",
        config.className
      )}
    >
      {config.label}
    </span>
  )
}

function CardFactRow({ item }: { item: ReviewQueueItemView }) {
  const threadsResolved = item.sinceLastReview?.threadsResolvedCount ?? 0
  const awaitingYourReply = item.reviewThreads.filter(
    (thread) => thread.status === "unresolved" && thread.awaitingYourReply
  ).length

  const facts: string[] = []
  if (item.size) {
    facts.push(`+${item.size.additions} −${item.size.deletions}`)
  }
  if (item.size?.fileCount !== undefined) {
    facts.push(`${item.size.fileCount} files`)
  }
  facts.push(
    item.newCommitCount > 0
      ? formatCount(item.newCommitCount, "new commit")
      : "no new commits"
  )
  facts.push(
    item.newReplyCount > 0
      ? formatCount(item.newReplyCount, "new reply")
      : "no new replies"
  )
  if (threadsResolved > 0) {
    facts.push(`${formatCount(threadsResolved, "thread")} resolved`)
  }
  if (awaitingYourReply > 0) {
    facts.push(`${awaitingYourReply} of yours unanswered`)
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
      {facts.map((fact, index) => (
        <span key={`fact-${index}`} className="inline-flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          {fact}
        </span>
      ))}
      {item.checks ? (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span
            className={
              item.checks.state === "failure"
                ? "font-medium text-destructive"
                : item.checks.state === "success"
                  ? "font-medium text-emerald-700"
                  : "text-muted-foreground"
            }
          >
            CI {item.checks.state}
          </span>
        </span>
      ) : null}
      {item.labels.length > 0 ? (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />
          <span className="flex flex-wrap items-center gap-1">
            {item.labels.slice(0, 4).map((label) => (
              <span
                key={label.name}
                title={
                  label.description
                    ? `${label.name}: ${label.description}`
                    : label.name
                }
                className={cn(
                  "rounded-full border px-2 py-[2px] font-medium",
                  !label.color && "border-border bg-muted/30 text-muted-foreground"
                )}
                style={githubLabelStyle(label.color)}
              >
                {label.name}
              </span>
            ))}
          </span>
        </span>
      ) : null}
    </div>
  )
}

function TextInset({
  title,
  accent = false,
  children,
}: {
  title: string
  accent?: boolean
  children: string
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        accent
          ? "border-violet-100 bg-violet-50/50"
          : "border-border bg-muted/20"
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {accent ? <Sparkles className="h-3 w-3 text-violet-500" /> : null}
        {title}
      </div>
      <p className="text-sm leading-6 text-foreground">{children}</p>
    </div>
  )
}

function buildQueueFallback(
  input: ReturnType<typeof buildAiDashboardInput>
): { body: string; bullets: Array<{ tone?: string; text: string }> } {
  return {
    body: `You have ${input.metrics.openReviewCount} open reviews across ${input.metrics.repositoryCount} repos - ${input.metrics.yourMoveCount} in your court, ${input.metrics.waitingOnAuthorCount} with their authors.`,
    bullets: [
      input.metrics.yourMoveCount > 0
        ? {
            tone: "urgent",
            text: `${input.metrics.yourMoveCount} review${
              input.metrics.yourMoveCount === 1 ? "" : "s"
            } need your next move.`,
          }
        : undefined,
      input.metrics.waitingOnAuthorCount > 0
        ? {
            tone: "stalled",
            text: `${input.metrics.waitingOnAuthorCount} review${
              input.metrics.waitingOnAuthorCount === 1 ? "" : "s"
            } are waiting on author follow-up.`,
          }
        : undefined,
      input.metrics.stalledCount > 0
        ? {
            tone: "info",
            text: `${input.metrics.stalledCount} item${
              input.metrics.stalledCount === 1 ? "" : "s"
            } crossed a stalled or overdue threshold.`,
          }
        : undefined,
    ].filter(Boolean) as Array<{ tone?: string; text: string }>,
  }
}

function buildSinceFallback(
  input: ReturnType<typeof buildAiDashboardInput>,
  items: ReviewQueueItemView[]
): { body: string; bullets: Array<{ text: string }> } {
  const active = items.filter((item) => item.unseenEventCount > 0)
  return {
    body:
      input.metrics.activeSinceLastVisitCount === 0
        ? "No board items have new local activity since your last visit."
        : `${input.metrics.activeSinceLastVisitCount} review${
            input.metrics.activeSinceLastVisitCount === 1 ? "" : "s"
          } saw activity since your last visit.`,
    bullets: active.slice(0, 4).map((item) => ({
      text: `${item.authorLogin} moved ${item.repository} #${item.number}: ${deterministicSinceYouLooked(
        item
      )}`,
    })),
  }
}

function deterministicSinceYouLooked(item: ReviewQueueItemView): string {
  const events = item.activityEvents.filter((event) => event.isNew)
  if (events.length === 0) return "No new activity since you last looked."
  return events
    .slice(0, 3)
    .map((event) => `${event.actor} ${event.action}`)
    .join("; ")
}

function deterministicNextAction(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") {
    if (item.unresolvedThreadCount > 0) {
      return "Reply to the open review threads, then re-review the latest changes."
    }
    return "Re-review the latest activity and approve or request changes."
  }
  if (item.waitingOn === "author") {
    return "Wait for the author to respond or push the requested changes."
  }
  return "No direct action is assigned right now."
}

function matchesFilter(
  item: ReviewQueueItemView,
  filter: DashboardFilter
): boolean {
  if (filter === "all") return true
  if (filter === "your-move") return item.waitingOn === "you"
  if (filter === "waiting") return item.waitingOn === "author"
  return item.workflowState === "stale" || item.waitingUrgency === "overdue"
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
