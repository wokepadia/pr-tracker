import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { ReactNode } from "react"
import {
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import {
  generateAiCatchUpDigest,
  generateAiPrSummary,
  generateAiThreadState,
  getAiCatchUpDigest,
  getAiPrSummary,
  getAiThreadState,
  type AiGenerated,
} from "@/api"
import type {
  CatchUpDigestContent,
  PrSummaryContent,
  ThreadStateContent,
} from "@/ai/summaries"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/reviewer/view-model"

/**
 * Shared shell for the AI mode panels on the pull request page. These
 * panels render only when AI mode is active (the parent gates on that), and
 * generation only ever happens from the explicit button — never on load.
 */
export function AiPanelShell<T>({
  title,
  hint,
  generateLabel,
  staleNote,
  result,
  isLoadingCache,
  isGenerating,
  error,
  onGenerate,
  renderContent,
}: {
  title: string
  hint: string
  generateLabel: string
  staleNote: string
  result: AiGenerated<T> | undefined
  isLoadingCache: boolean
  isGenerating: boolean
  error: Error | null
  onGenerate: () => void
  renderContent: (content: T) => ReactNode
}) {
  if (isLoadingCache) {
    return null
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          {title}
          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-[1px] font-normal">
            AI-generated · may be inaccurate
          </span>
        </div>
        {result ? (
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

      {result ? (
        <div className="mt-3">
          {renderContent(result.content)}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              Generated {formatRelativeTime(result.generatedAt)} ·{" "}
              {result.model}
            </span>
            {result.isStale ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-[1px] text-amber-800">
                {staleNote}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-5 text-muted-foreground">
            {hint}
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
            {generateLabel}
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

export function AiPrSummaryPanel({ pullRequestId }: { pullRequestId: string }) {
  const queryClient = useQueryClient()
  const summaryQuery = useQuery({
    queryKey: ["ai-pr-summary", pullRequestId],
    queryFn: () => getAiPrSummary(pullRequestId),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiPrSummary(pullRequestId),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-pr-summary", pullRequestId], result)
    },
  })

  return (
    <AiPanelShell<PrSummaryContent>
      title="AI summary"
      hint="Summarize what this pull request changes. Sends the title, description, and diff to OpenRouter using your key."
      generateLabel="Summarize this PR"
      staleNote="New commits since this summary"
      result={summaryQuery.data}
      isLoadingCache={summaryQuery.isLoading}
      isGenerating={generateMutation.isPending}
      error={generateMutation.error}
      onGenerate={() => generateMutation.mutate()}
      renderContent={(content) => (
        <div>
          <p className="text-sm leading-6 text-foreground">
            {content.overview}
          </p>
          {content.keyChanges.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-sm leading-5 text-foreground">
              {content.keyChanges.map((change) => (
                <li key={`${change.file}-${change.description}`} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>
                    <code className="rounded bg-muted/60 px-1 py-[1px] text-xs">
                      {change.file}
                    </code>{" "}
                    {change.description}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    />
  )
}

export function AiCatchUpDigestPanel({
  pullRequestId,
  lastSeenAt,
  hasNewActivity,
}: {
  pullRequestId: string
  lastSeenAt?: string
  hasNewActivity: boolean
}) {
  const queryClient = useQueryClient()
  // lastSeenAt is part of the key so marking caught-up refreshes the cached
  // digest's staleness immediately.
  const digestQuery = useQuery({
    queryKey: ["ai-catch-up-digest", pullRequestId, lastSeenAt ?? null],
    queryFn: () => getAiCatchUpDigest(pullRequestId),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiCatchUpDigest(pullRequestId),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["ai-catch-up-digest", pullRequestId, lastSeenAt ?? null],
        result
      )
    },
  })

  // Without new activity there is nothing to digest; only a previously
  // generated digest is worth showing.
  if (!hasNewActivity && !digestQuery.data) {
    return null
  }

  return (
    <AiPanelShell<CatchUpDigestContent>
      title="AI catch-up"
      hint="Digest what happened since you last caught up. Sends the new activity (comments, reviews, pushes) to OpenRouter using your key."
      generateLabel="Digest new activity"
      staleNote="More activity since this digest"
      result={digestQuery.data}
      isLoadingCache={digestQuery.isLoading}
      isGenerating={generateMutation.isPending}
      error={generateMutation.error}
      onGenerate={() => generateMutation.mutate()}
      renderContent={(content) => (
        <div>
          <p className="text-sm leading-6 text-foreground">
            {content.narrative}
          </p>
          {content.bullets.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-sm leading-5 text-foreground">
              {content.bullets.map((bullet) => (
                <li key={bullet} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    />
  )
}

export function AiThreadStatePanel({
  pullRequestId,
  hasThreads,
}: {
  pullRequestId: string
  hasThreads: boolean
}) {
  const queryClient = useQueryClient()
  const threadStateQuery = useQuery({
    queryKey: ["ai-thread-state", pullRequestId],
    queryFn: () => getAiThreadState(pullRequestId),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiThreadState(pullRequestId),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-thread-state", pullRequestId], result)
    },
  })

  if (!hasThreads && !threadStateQuery.data) {
    return null
  }

  return (
    <AiPanelShell<ThreadStateContent>
      title="AI thread state"
      hint="Summarize where the review threads stand: who owes a reply and what is still contested. Sends the cached threads and comments to OpenRouter using your key."
      generateLabel="Summarize threads"
      staleNote="Threads changed since this summary"
      result={threadStateQuery.data}
      isLoadingCache={threadStateQuery.isLoading}
      isGenerating={generateMutation.isPending}
      error={generateMutation.error}
      onGenerate={() => generateMutation.mutate()}
      renderContent={(content) => (
        <div>
          <p className="text-sm leading-6 text-foreground">{content.overall}</p>
          {content.threadNotes.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-sm leading-5 text-foreground">
              {content.threadNotes.map((note) => (
                <li key={`${note.file}-${note.note}`} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>
                    <code className="rounded bg-muted/60 px-1 py-[1px] text-xs">
                      {note.file}
                    </code>{" "}
                    {note.note}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    />
  )
}
