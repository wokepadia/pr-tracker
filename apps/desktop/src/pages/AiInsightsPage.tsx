import { useMemo } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react"
import {
  generateAiInsights,
  getAiInsights,
  getAiSettings,
  getGithubSettingsStatus,
  visitInsights,
  type AiGenerated,
} from "@/api"
import {
  buildAiInsightsInput,
  type AiInsightsContent,
} from "@/ai/ai-insights"
import { isAiModeActive } from "@/ai/ai-settings"
import { useGithubSync } from "@/app/use-github-sync"
import { useReviewerInsights } from "@/app/use-reviewer-insights"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { Button } from "@/components/ui/button"
import {
  buildAiDashboardStats,
  type AiDashboardAuthorRow,
  type AiDashboardHotspotRow,
  type AiDashboardRepositoryRow,
} from "@/reviewer/ai-dashboard-stats"
import {
  formatRelativeTime,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import { formatSyncStatusLabel } from "./inbox-helpers"
import { cn, externalLinkProps } from "@/lib/utils"
import type { ReviewerInsightsView } from "@/reviewer/insights"

/**
 * The AI insights view is a deterministic dashboard with narrow AI slots.
 * Its route still reads through the board-scoped insights hook, so the
 * widgets, AI input, and generated prose all share the same board universe.
 */
export function AiInsightsPage() {
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
  const {
    insights,
    allItems,
  } = useReviewerInsights({
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
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-6 py-6">
        {aiSettingsQuery.isLoading ? null : !aiActive ? (
          <AiModeOffCard />
        ) : !insights || !allItems || visitQuery.isLoading ? (
          <div
            aria-busy="true"
            className="h-32 animate-pulse rounded-md border border-border bg-muted/40"
          />
        ) : (
          <AiInsightsBody
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
    <div className="grid place-items-center rounded-lg border border-border bg-card px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        AI mode is off
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        Add a provider key and enable AI mode to generate a briefing over
        your board. Nothing is sent anywhere until you do.
      </p>
      <Button asChild className="mt-5 rounded-md" variant="outline">
        <Link to="/settings">Open settings</Link>
      </Button>
    </div>
  )
}

function AiInsightsBody({
  insights,
  allItems,
  syncLabel,
  isSyncing,
  onSyncNow,
}: {
  insights: ReviewerInsightsView
  allItems: ReviewQueueItemView[]
  syncLabel: string
  isSyncing: boolean
  onSyncNow: () => void
}) {
  const queryClient = useQueryClient()
  const stats = useMemo(
    () =>
      buildAiDashboardStats({
        items: allItems,
      }),
    [allItems]
  )
  const input = useMemo(
    () => buildAiInsightsInput(insights, allItems),
    [insights, allItems]
  )
  const inputKey = useMemo(() => JSON.stringify(input), [input])
  const itemById = useMemo(
    () => new Map(allItems.map((item) => [item.id, item])),
    [allItems]
  )
  const insightsQuery = useQuery({
    queryKey: ["ai-insights", inputKey],
    queryFn: () => getAiInsights(input),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiInsights(input),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-insights", inputKey], result)
    },
  })
  const result = insightsQuery.data ?? undefined
  const canGenerate = input.items.length > 0 && !generateMutation.isPending
  const unseenCount = allItems.filter((item) => item.unseenEventCount > 0).length

  if (allItems.length === 0) {
    return (
      <>
        <DashboardHeader
          insights={insights}
          itemCount={allItems.length}
          unseenCount={unseenCount}
          omittedCount={input.omittedCount}
          result={result}
          isLoadingCache={insightsQuery.isLoading}
          isGenerating={generateMutation.isPending}
          canGenerate={false}
          error={generateMutation.error}
          syncLabel={syncLabel}
          isSyncing={isSyncing}
          onSyncNow={onSyncNow}
          onGenerate={() => generateMutation.mutate()}
        />
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing to brief - the applied board filter has no pull requests
          right now.
        </div>
      </>
    )
  }

  return (
    <>
      <DashboardHeader
        insights={insights}
        itemCount={allItems.length}
        unseenCount={unseenCount}
        omittedCount={input.omittedCount}
        result={result}
        isLoadingCache={insightsQuery.isLoading}
        isGenerating={generateMutation.isPending}
        canGenerate={canGenerate}
        error={generateMutation.error}
        syncLabel={syncLabel}
        isSyncing={isSyncing}
        onSyncNow={onSyncNow}
        onGenerate={() => generateMutation.mutate()}
      />

      <AiHeadlineSlot
        result={result}
        isLoadingCache={insightsQuery.isLoading}
        canGenerate={canGenerate}
        isGenerating={generateMutation.isPending}
        onGenerate={() => generateMutation.mutate()}
      />

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8 flex flex-col gap-4">
          <DashboardCard id="ai-reading-order" className="min-h-[300px]">
            {result ? (
              <AiInsightSection
                title="What needs you"
                caption="A suggested reading order, most pressing first"
                emptyLine="The model had nothing waiting on you."
                entries={result.content.readingOrder.map((entry) => ({
                  pullRequestId: entry.pullRequestId,
                  text: entry.why,
                }))}
                itemById={itemById}
                ordered
              />
            ) : (
              <AiSlotPlaceholder
                title="What needs you"
                caption="A suggested reading order, most pressing first"
              />
            )}
          </DashboardCard>

          <DashboardCard id="ai-while-away" className="min-h-[240px]">
            {result ? (
              <AiInsightSection
                title="While you were away"
                caption="What concluded or changed without you"
                emptyLine="Nothing finished without you."
                entries={result.content.whileAway.map((entry) => ({
                  pullRequestId: entry.pullRequestId,
                  text: entry.note,
                }))}
                itemById={itemById}
              />
            ) : (
              <AiSlotPlaceholder
                title="While you were away"
                caption="What concluded or changed without you"
              />
            )}
          </DashboardCard>
        </div>

        <div className="col-span-4 flex flex-col gap-4">
          {stats.repositoryBreakdown.isHidden ? null : (
            <RepositoryBreakdownCard
              rows={stats.repositoryBreakdown.rows}
              remainingCount={stats.repositoryBreakdown.remainingCount}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <DashboardCard id="ai-sweep" className="col-span-4 min-h-[220px]">
          {result ? (
            <AiInsightSection
              title="Worth a sweep"
              caption="The aging and stuck items, grouped"
              emptyLine="Nothing is gathering dust."
              entries={result.content.sweep.map((entry) => ({
                pullRequestId: entry.pullRequestId,
                text: entry.note,
              }))}
              itemById={itemById}
            />
          ) : (
            <AiSlotPlaceholder
              title="Worth a sweep"
              caption="The aging and stuck items, grouped"
            />
          )}
        </DashboardCard>

        <DiscussionHotspotsCard rows={stats.discussionHotspots} />
        {stats.authorsWaiting.isHidden ? null : (
          <AuthorsWaitingCard rows={stats.authorsWaiting.rows} />
        )}
      </div>
    </>
  )
}

function DashboardHeader({
  insights,
  itemCount,
  unseenCount,
  omittedCount,
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
  insights: ReviewerInsightsView
  itemCount: number
  unseenCount: number
  omittedCount: number
  result: AiGenerated<AiInsightsContent> | undefined
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
              AI Insights
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
            An AI narration over your board — it restates the deterministic
            insights, never re-judges them, and only ever sees items on the
            board.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Built from {itemCount} board item
            {itemCount === 1 ? "" : "s"} · {insights.totalCount} flagged
            · {unseenCount} with unseen activity
            {omittedCount > 0 ? ` · ${omittedCount} lower-priority omitted` : ""}
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

function AiHeadlineSlot({
  result,
  isLoadingCache,
  canGenerate,
  isGenerating,
  onGenerate,
}: {
  result: AiGenerated<AiInsightsContent> | undefined
  isLoadingCache: boolean
  canGenerate: boolean
  isGenerating: boolean
  onGenerate: () => void
}) {
  return (
    <DashboardCard id="ai-headline">
      {isLoadingCache ? null : result ? (
        <p className="text-sm leading-6 text-foreground">
          {result.content.headline}
        </p>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              AI-generated · may be inaccurate
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-5 text-muted-foreground">
              Generate a short briefing over your board: what needs you and in
              which order, what finished while you were away, and what is
              gathering dust.
            </p>
          </div>
          <Button
            className="h-8 shrink-0 rounded-md text-xs"
            disabled={!canGenerate}
            type="button"
            onClick={onGenerate}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Generate
          </Button>
        </div>
      )}
    </DashboardCard>
  )
}

function AiSlotPlaceholder({
  title,
  caption,
}: {
  title: string
  caption: string
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground/70">· {caption}</span>
      </div>
      <div className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        Generate to fill this AI slot.
      </div>
    </section>
  )
}

function RepositoryBreakdownCard({
  rows,
  remainingCount,
}: {
  rows: AiDashboardRepositoryRow[]
  remainingCount: number
}) {
  return (
    <DashboardCard title="Repository breakdown">
      <div className="space-y-2">
        {rows.map((row) => (
          <Link
            key={row.repository}
            to="/"
            className="grid grid-cols-[1fr_48px_56px_48px] gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="truncate font-medium text-foreground">
              {row.repository}
            </span>
            <span className="text-right tabular-nums">{row.itemCount}</span>
            <span className="text-right tabular-nums">
              {row.waitingOnYouCount}
            </span>
            <span className="text-right">{row.oldestWaitLabel}</span>
          </Link>
        ))}
        {remainingCount > 0 ? (
          <div className="text-xs text-muted-foreground">
            +{remainingCount} more repositories
          </div>
        ) : null}
      </div>
    </DashboardCard>
  )
}

function DiscussionHotspotsCard({ rows }: { rows: AiDashboardHotspotRow[] }) {
  return (
    <DashboardCard
      id="discussion-hotspots"
      className="col-span-4 min-h-[220px]"
      title="Discussion hotspots"
    >
      {rows.length === 0 ? (
        <EmptyWidgetLine>No unresolved review threads.</EmptyWidgetLine>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {rows.map((row) => (
            <DeterministicPrRow
              key={row.item.id}
              item={row.item}
              detail={`${row.unresolvedThreadCount} unresolved ${row.unresolvedThreadCount === 1 ? "thread" : "threads"} · last reply from ${row.lastReplyLogin}${
                row.lastReplyAtIso ? ` ${formatRelativeTime(row.lastReplyAtIso)}` : ""
              }`}
            />
          ))}
        </div>
      )}
    </DashboardCard>
  )
}

function AuthorsWaitingCard({ rows }: { rows: AiDashboardAuthorRow[] }) {
  return (
    <DashboardCard
      id="authors-waiting"
      className="col-span-4 min-h-[220px]"
      title="Authors waiting on you"
    >
      <div className="space-y-2">
        {rows.map((row) => (
          <Link
            key={row.login}
            to="/"
            className="grid grid-cols-[28px_1fr_40px_56px] items-center gap-2 rounded-md px-1 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <AuthorAvatar
              className="h-7 w-7 text-[10px]"
              login={row.login}
              avatarUrl={row.avatarUrl}
            />
            <span className="truncate font-medium text-foreground">
              {row.login}
            </span>
            <span className="text-right tabular-nums">{row.count}</span>
            <span className="text-right">{row.oldestWaitLabel}</span>
          </Link>
        ))}
      </div>
    </DashboardCard>
  )
}

function DashboardCard({
  title,
  id,
  className,
  children,
}: {
  title?: string
  id?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      className={cn("rounded-md border border-border bg-card p-4", className)}
    >
      {title ? (
        <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function EmptyWidgetLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function AiInsightSection({
  title,
  caption,
  emptyLine,
  entries,
  itemById,
  ordered = false,
}: {
  title: string
  caption: string
  emptyLine: string
  entries: Array<{ pullRequestId: string; text: string }>
  itemById: Map<string, ReviewQueueItemView>
  ordered?: boolean
}) {
  const linkable = entries.flatMap((entry) => {
    const item = itemById.get(entry.pullRequestId)
    return item ? [{ ...entry, item }] : []
  })

  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {linkable.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground">
            {linkable.length}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground/70">· {caption}</span>
      </div>
      {linkable.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground">
          {emptyLine}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {linkable.map((entry, index) => (
            <AiInsightRow
              key={entry.pullRequestId}
              index={ordered ? index + 1 : undefined}
              isFirst={index === 0}
              item={entry.item}
              text={entry.text}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function AiInsightRow({
  item,
  text,
  index,
  isFirst,
}: {
  item: ReviewQueueItemView
  text: string
  index?: number
  isFirst: boolean
}) {
  const navigate = useNavigate()

  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/40",
        !isFirst && "border-t border-border"
      )}
      role="link"
      tabIndex={0}
      onClick={() =>
        void navigate({
          to: "/pull-requests/$pullRequestId",
          params: { pullRequestId: item.id },
        })
      }
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        void navigate({
          to: "/pull-requests/$pullRequestId",
          params: { pullRequestId: item.id },
        })
      }}
    >
      {index !== undefined ? (
        <span className="w-4 shrink-0 text-right text-xs font-medium text-muted-foreground">
          {index}.
        </span>
      ) : null}
      <AuthorAvatar
        className="h-7 w-7"
        login={item.authorLogin}
        avatarUrl={item.authorAvatarUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {item.repository}{" "}
            <span className="text-muted-foreground/60">#{item.number}</span>
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {item.title}
          </span>
          <span className="text-sm text-muted-foreground">— {text}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <a
          href={item.url}
          {...externalLinkProps}
          aria-label="Open in GitHub"
          title="Open in GitHub"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  )
}

function DeterministicPrRow({
  item,
  detail,
}: {
  item: ReviewQueueItemView
  detail: string
}) {
  return (
    <Link
      to="/pull-requests/$pullRequestId"
      params={{ pullRequestId: item.id }}
      className="group flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
    >
      <AuthorAvatar
        className="h-7 w-7"
        login={item.authorLogin}
        avatarUrl={item.authorAvatarUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">
          {item.repository}{" "}
          <span className="text-muted-foreground/60">#{item.number}</span>
        </div>
        <div className="truncate text-sm font-medium text-foreground">
          {item.title}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {detail}
        </div>
      </div>
      <a
        href={item.url}
        {...externalLinkProps}
        aria-label="Open in GitHub"
        title="Open in GitHub"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </Link>
  )
}
