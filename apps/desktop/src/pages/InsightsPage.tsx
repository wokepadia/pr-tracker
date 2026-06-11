import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState, type ReactNode } from "react"
import {
  ArchiveRestore,
  Check,
  CircleAlert,
  EyeOff,
  ExternalLink,
  History,
  RotateCcw,
  Sparkles,
  Timer,
} from "lucide-react"
import {
  getAiSettings,
  getBoardState,
  getGithubSettingsStatus,
  saveBoardState,
  visitInsights,
} from "@/api"
import { isAiModeActive } from "@/ai/ai-settings"
import { useGithubSync } from "@/app/use-github-sync"
import { useReviewerInsights } from "@/app/use-reviewer-insights"
import { AiQueueBriefPanel } from "@/components/AiQueueBriefPanel"
import { AuthorAvatar } from "@/components/AuthorAvatar"
import { Button } from "@/components/ui/button"
import { formatSyncStatusLabel } from "./inbox-helpers"
import { cn, externalLinkProps } from "@/lib/utils"
import {
  type InsightRowView,
  type InsightsDigestView,
} from "@/reviewer/insights"

const SECTION_ROW_CAP = 5

interface InsightSectionDefinition {
  id: "needsYouNow" | "mightBeMissing" | "whileAway" | "hygiene"
  title: string
  caption: string
  emptyLine: string
  icon: typeof CircleAlert
  accentClassName: string
  chipClassName: string
}

const insightSections: InsightSectionDefinition[] = [
  {
    id: "needsYouNow",
    title: "Needs you now",
    caption: "Past a threshold or back on your turn",
    emptyLine: "No reviews are waiting on you.",
    icon: CircleAlert,
    accentClassName: "bg-amber-500",
    chipClassName: "border-amber-200 bg-amber-50 text-amber-900",
  },
  {
    id: "mightBeMissing",
    title: "You might be missing this",
    caption: "Where remote activity disagrees with your marks",
    emptyLine: "Nothing has slipped past your marks.",
    icon: EyeOff,
    accentClassName: "bg-sky-500",
    chipClassName: "border-sky-200 bg-sky-50 text-sky-900",
  },
  {
    id: "whileAway",
    title: "While you were away",
    caption: "Quiet finishes since your last visit",
    emptyLine: "Nothing finished without you.",
    icon: History,
    accentClassName: "bg-violet-500",
    chipClassName: "border-violet-200 bg-violet-50 text-violet-900",
  },
  {
    id: "hygiene",
    title: "Worth a sweep",
    caption: "Aging and stuck items, for a weekly pass",
    emptyLine: "Nothing is gathering dust.",
    icon: Timer,
    accentClassName: "bg-slate-400",
    chipClassName: "border-border bg-muted/40 text-muted-foreground",
  },
]

export function InsightsPage() {
  const queryClient = useQueryClient()
  const githubSync = useGithubSync()
  const boardStateQuery = useQuery({
    queryKey: ["board-state"],
    queryFn: getBoardState,
  })
  const githubSettingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const visitQuery = useQuery({
    queryKey: ["insights-visit"],
    queryFn: visitInsights,
    staleTime: Infinity,
  })
  const restoreMutation = useMutation({
    mutationFn: saveBoardState,
    onSuccess: (savedState) => {
      queryClient.setQueryData(["board-state"], savedState)
    },
  })

  const { insights: computedInsights, allItems } = useReviewerInsights({
    previousVisitAt: visitQuery.data?.previousVisitAt,
  })
  const insights = visitQuery.isLoading ? undefined : computedInsights
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  })
  const aiActive = isAiModeActive(aiSettingsQuery.data)

  function restoreItem(itemId: string) {
    const boardState = boardStateQuery.data
    if (!boardState) return

    const currentItemState = boardState.localQueueState[itemId]
    if (!currentItemState) return

    const nextItemState = { ...currentItemState }
    delete nextItemState.snoozed
    delete nextItemState.snoozedAt
    delete nextItemState.muted
    delete nextItemState.mutedAt

    restoreMutation.mutate({
      ...boardState,
      localQueueState: {
        ...boardState.localQueueState,
        [itemId]: nextItemState,
      },
    })
  }

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Insights
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
            What the system noticed for you — exceptions, deltas, and
            contradictions only. The queue itself lives in the inbox.
          </p>
        </div>

        {insights?.digest ? <DigestStrip digest={insights.digest} /> : null}

        {aiActive && insights && allItems ? (
          <AiQueueBriefPanel insights={insights} allItems={allItems} />
        ) : null}

        {!insights ? (
          <div className="h-64" aria-busy="true" />
        ) : insights.totalCount === 0 ? (
          <AllCaughtUp />
        ) : (
          insightSections.map((section) => (
            <InsightSection
              key={section.id}
              definition={section}
              rows={insights[section.id]}
              isRestoring={restoreMutation.isPending}
              onRestore={restoreItem}
            />
          ))
        )}
      </div>
    </div>
  )
}

function DigestStrip({ digest }: { digest: InsightsDigestView }) {
  const parts: string[] = []
  if (digest.updatedPullRequestCount > 0) {
    parts.push(
      `${digest.updatedPullRequestCount} PR${
        digest.updatedPullRequestCount === 1 ? "" : "s"
      } updated`
    )
  }
  if (digest.mergedCount > 0) {
    parts.push(`${digest.mergedCount} merged`)
  }
  if (digest.newReviewRequestCount > 0) {
    parts.push(
      `${digest.newReviewRequestCount} new review request${
        digest.newReviewRequestCount === 1 ? "" : "s"
      }`
    )
  }
  if (parts.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-card px-4 py-2.5 text-sm text-foreground">
      <Sparkles className="h-4 w-4 text-amber-500" />
      <span className="font-medium">Since you were last here:</span>
      <span className="text-muted-foreground">{parts.join(" · ")}</span>
    </div>
  )
}

function AllCaughtUp() {
  return (
    <div className="grid place-items-center rounded-lg border border-border bg-card px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-600">
        <Check className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        You&apos;re all caught up
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        Nothing needs your attention, nothing slipped past your marks, and
        nothing finished without you. Enjoy the quiet.
      </p>
      <Button asChild className="mt-5 rounded-md" variant="outline">
        <Link to="/">Back to inbox</Link>
      </Button>
    </div>
  )
}

function InsightSection({
  definition,
  rows,
  isRestoring,
  onRestore,
}: {
  definition: InsightSectionDefinition
  rows: InsightRowView[]
  isRestoring: boolean
  onRestore: (itemId: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const visibleRows = showAll ? rows : rows.slice(0, SECTION_ROW_CAP)
  const hiddenCount = rows.length - visibleRows.length
  const Icon = definition.icon

  return (
    <section aria-label={definition.title}>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={cn(
            "h-[7px] w-[7px] self-center rounded-full",
            rows.length > 0
              ? definition.accentClassName
              : "bg-muted-foreground/30"
          )}
        />
        <h2 className="text-sm font-semibold text-foreground">
          {definition.title}
        </h2>
        {rows.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground">
            {rows.length}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground/70">
          · {definition.caption}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          {definition.emptyLine}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {visibleRows.map((row, index) => (
            <InsightRowLine
              key={row.id}
              row={row}
              chipClassName={definition.chipClassName}
              icon={<Icon className="h-3.5 w-3.5" />}
              isFirst={index === 0}
              isRestoring={isRestoring}
              onRestore={
                row.kind === "snoozed_moved_on" ||
                row.kind === "muted_rerequested"
                  ? onRestore
                  : undefined
              }
            />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="block w-full border-t border-border px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              Show all {rows.length}
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}

function InsightRowLine({
  row,
  chipClassName,
  icon,
  isFirst,
  isRestoring,
  onRestore,
}: {
  row: InsightRowView
  chipClassName: string
  icon: ReactNode
  isFirst: boolean
  isRestoring: boolean
  onRestore?: (itemId: string) => void
}) {
  const navigate = useNavigate()
  const item = row.item

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
      <AuthorAvatar
        className="h-7 w-7"
        login={item.authorLogin}
        avatarUrl={item.authorAvatarUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {item.repository} <span className="text-muted-foreground/60">#{item.number}</span>
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {item.title}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[1px] text-xs",
              chipClassName
            )}
          >
            {icon}
            {row.whyChip}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onRestore ? (
          <Button
            className="h-7 rounded-md px-2 text-xs"
            disabled={isRestoring}
            size="sm"
            type="button"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation()
              onRestore(item.id)
            }}
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
            Restore
          </Button>
        ) : null}
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
