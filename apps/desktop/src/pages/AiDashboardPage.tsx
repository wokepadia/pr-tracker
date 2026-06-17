import { useMemo, useState } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
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
import { Button } from "@/components/ui/button"
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
  const { insights, allItems } = useReviewerInsights({
    previousVisitAt: visitQuery.data?.previousVisitAt,
    scope: "board",
  })
  const aiActive = isAiModeActive(aiSettingsQuery.data)
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
        ) : !insights || !allItems || visitQuery.isLoading ? (
          <div
            aria-busy="true"
            className="h-32 animate-pulse rounded-md border border-border bg-muted/40"
          />
        ) : (
          <AiDashboardBody
            insights={insights}
            allItems={allItems}
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
  insights,
  allItems,
  syncLabel,
  isSyncing,
  onSyncNow,
}: {
  insights: Parameters<typeof buildAiDashboardInput>[0]
  allItems: ReviewQueueItemView[]
  syncLabel: string
  isSyncing: boolean
  onSyncNow: () => void
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<DashboardFilter>("all")
  const input = useMemo(
    () => buildAiDashboardInput(insights, allItems),
    [insights, allItems]
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
          title="Since your last visit"
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
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
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
  const laneLabel =
    item.waitingOn === "you"
      ? "Your move"
      : item.waitingOn === "author"
        ? "Waiting on author"
        : "Watching"
  const summary = generated?.summary ?? item.reason
  const sinceYouLooked =
    generated?.sinceYouLooked ?? deterministicSinceYouLooked(item)
  const nextAction = generated?.nextAction ?? deterministicNextAction(item)

  return (
    <section
      className={cn(
        "rounded-md border border-l-4 border-border bg-card p-4",
        laneTone
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {laneLabel}
            </span>
            {item.waitingUrgency !== "none" ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-[2px] text-xs font-medium text-amber-800">
                {item.waitingUrgency === "overdue" ? "stalled" : "aging"}{" "}
                {item.waitingAge} · on {item.waitingOn}
              </span>
            ) : null}
            <Link
              to="/pull-requests/$pullRequestId"
              params={{ pullRequestId: item.id }}
              className="min-w-0 truncate text-sm font-semibold text-foreground hover:underline"
            >
              {item.title}
            </Link>
            <span className="text-xs text-muted-foreground">
              {item.repository} #{item.number}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>active {item.updatedAt}</span>
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

      <p className="mt-3 text-sm leading-6 text-foreground">
        <span className="mr-2 text-xs font-medium text-muted-foreground">
          summary
        </span>
        {summary}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <TextInset title="since you looked">{sinceYouLooked}</TextInset>
        <TextInset title="what's next">{nextAction}</TextInset>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {item.size?.lineCount !== undefined ? (
          <span>{item.size.lineCount} changed lines</span>
        ) : null}
        {item.size?.fileCount !== undefined ? (
          <span>{item.size.fileCount} files</span>
        ) : null}
        <span>{formatCount(item.newCommitCount, "new commit")}</span>
        <span>{formatCount(item.newReplyCount, "new reply")}</span>
        <span>
          {item.unresolvedThreadCount === 0
            ? "no unresolved threads"
            : formatCount(item.unresolvedThreadCount, "unresolved thread")}
        </span>
        {item.checks ? (
          <span
            className={
              item.checks.state === "failure"
                ? "text-destructive"
                : item.checks.state === "success"
                  ? "text-emerald-700"
                  : "text-muted-foreground"
            }
          >
            CI {item.checks.state}
          </span>
        ) : null}
        {item.labels.slice(0, 4).map((label) => (
          <span
            key={label.name}
            className="rounded-full border border-border bg-muted/30 px-2 py-[2px]"
          >
            {label.name}
          </span>
        ))}
      </div>
    </section>
  )
}

function TextInset({
  title,
  children,
}: {
  title: string
  children: string
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
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
