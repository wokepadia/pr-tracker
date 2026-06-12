import { useMemo } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ExternalLink, RotateCcw, Sparkles } from "lucide-react"
import {
  generateAiInsights,
  getAiInsights,
  getAiSettings,
  getGithubSettingsStatus,
  visitInsights,
} from "@/api"
import {
  buildAiInsightsInput,
  type AiInsightsContent,
} from "@/ai/ai-insights"
import { isAiModeActive } from "@/ai/ai-settings"
import { useGithubSync } from "@/app/use-github-sync"
import { useReviewerInsights } from "@/app/use-reviewer-insights"
import { AiPanelShell } from "@/components/AiPanels"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { Button } from "@/components/ui/button"
import { formatSyncStatusLabel } from "./inbox-helpers"
import { cn, externalLinkProps } from "@/lib/utils"
import type { ReviewerInsightsView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

/**
 * The AI insights view: one user-triggered generation over the board,
 * rendered as separate sections. The input is strictly board-scoped (the
 * insights hook runs with scope "board"), the deterministic facts stay
 * authoritative, and titles and links always render from local data — the
 * model contributes only the headline and the per-PR sentences.
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
  // Shares the insights visit anchor, so the away window is the same one
  // the deterministic insights page narrates.
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

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            AI Insights
          </h1>
          <span className="text-xs text-muted-foreground">
            ·{" "}
            {formatSyncStatusLabel({
              isSyncing: githubSync.isSyncing,
              lastSyncedAt: githubSync.lastSyncedAt,
              tokenConfigured: Boolean(
                githubSettingsQuery.data?.tokenConfigured
              ),
            })}
          </span>
          <button
            type="button"
            aria-label="Sync with GitHub now"
            title="Sync with GitHub now"
            disabled={githubSync.isSyncing}
            onClick={githubSync.syncNow}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          >
            <RotateCcw
              className={cn("h-3.5 w-3.5", githubSync.isSyncing && "animate-spin")}
            />
          </button>
          <p className="w-full text-xs text-muted-foreground">
            An AI narration over your board — it restates the deterministic
            insights, never re-judges them, and only ever sees items on the
            board.
          </p>
        </div>

        {aiSettingsQuery.isLoading ? null : !aiActive ? (
          <AiModeOffCard />
        ) : !insights || !allItems || visitQuery.isLoading ? (
          <div
            aria-busy="true"
            className="h-32 animate-pulse rounded-md border border-border bg-muted/40"
          />
        ) : (
          <AiInsightsBody insights={insights} allItems={allItems} />
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
}: {
  insights: ReviewerInsightsView
  allItems: ReviewQueueItemView[]
}) {
  const queryClient = useQueryClient()
  const input = useMemo(
    () => buildAiInsightsInput(insights, allItems),
    [insights, allItems]
  )
  // The serialized input doubles as the cache identity: any board change
  // produces a new key, which re-reads the stored generation and recomputes
  // its staleness against the new input.
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
  const unseenCount = allItems.filter(
    (item) => item.unseenEventCount > 0
  ).length

  if (input.items.length === 0 && !insightsQuery.data) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing to brief — no board items are flagged or carrying unseen
        activity right now.
      </div>
    )
  }

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Built from {allItems.length} board item{allItems.length === 1 ? "" : "s"}{" "}
        · {insights.totalCount} flagged · {unseenCount} with unseen activity
        {input.omittedCount > 0
          ? ` · ${input.omittedCount} lower-priority omitted`
          : ""}
      </p>
      <AiPanelShell<AiInsightsContent>
        title="AI insights"
        hint="Generate a short briefing over your board: what needs you and in which order, what finished while you were away, and what is gathering dust. Sends the flagged pull requests' titles, flags, and unseen activity to your AI provider."
        generateLabel="Generate"
        staleNote="The board changed since this was generated"
        result={insightsQuery.data ?? undefined}
        isLoadingCache={insightsQuery.isLoading}
        isGenerating={generateMutation.isPending}
        error={generateMutation.error}
        onGenerate={() => generateMutation.mutate()}
        renderContent={(content) => (
          <div className="flex flex-col gap-5">
            <p className="text-sm leading-6 text-foreground">
              {content.headline}
            </p>
            <AiInsightSection
              title="What needs you"
              caption="A suggested reading order, most pressing first"
              emptyLine="The model had nothing waiting on you."
              entries={content.readingOrder.map((entry) => ({
                pullRequestId: entry.pullRequestId,
                text: entry.why,
              }))}
              itemById={itemById}
              ordered
            />
            <AiInsightSection
              title="While you were away"
              caption="What concluded or changed without you"
              emptyLine="Nothing finished without you."
              entries={content.whileAway.map((entry) => ({
                pullRequestId: entry.pullRequestId,
                text: entry.note,
              }))}
              itemById={itemById}
            />
            <AiInsightSection
              title="Worth a sweep"
              caption="The aging and stuck items, grouped"
              emptyLine="Nothing is gathering dust."
              entries={content.sweep.map((entry) => ({
                pullRequestId: entry.pullRequestId,
                text: entry.note,
              }))}
              itemById={itemById}
            />
          </div>
        )}
      />
    </>
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
