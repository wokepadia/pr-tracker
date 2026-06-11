import { useMemo } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  generateAiQueueBrief,
  getAiQueueBrief,
} from "@/api"
import {
  buildQueueBriefInput,
  type QueueBriefContent,
} from "@/ai/queue-brief"
import { AiPanelShell } from "@/components/AiPanels"
import type { ReviewerInsightsView } from "@/reviewer/insights"
import type { ReviewQueueItemView } from "@/reviewer/view-model"

/**
 * The AI layer of the insights page: one user-triggered brief that narrates
 * the deterministic sections below it. Titles and links always render from
 * local data; the model contributes only the headline and the per-PR why
 * and note strings, restricted to pull requests in the rollup input.
 */
export function AiQueueBriefPanel({
  insights,
  allItems,
}: {
  insights: ReviewerInsightsView
  allItems: ReviewQueueItemView[]
}) {
  const queryClient = useQueryClient()
  const input = useMemo(
    () => buildQueueBriefInput(insights, allItems),
    [insights, allItems]
  )
  // The serialized input doubles as the cache identity: any queue change
  // produces a new key, which re-reads the stored brief and recomputes its
  // staleness against the new input.
  const inputKey = useMemo(() => JSON.stringify(input), [input])
  const itemById = useMemo(
    () => new Map(allItems.map((item) => [item.id, item])),
    [allItems]
  )
  const briefQuery = useQuery({
    queryKey: ["ai-queue-brief", inputKey],
    queryFn: () => getAiQueueBrief(input),
  })
  const generateMutation = useMutation({
    mutationFn: () => generateAiQueueBrief(input),
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-queue-brief", inputKey], result)
    },
  })

  if (input.items.length === 0 && !briefQuery.data) {
    return null
  }

  return (
    <AiPanelShell<QueueBriefContent>
      title="AI brief"
      hint="Turn the insights below into a short reading plan. Sends the flagged pull requests' titles, flags, and unseen activity to OpenRouter using your key."
      generateLabel="Brief me"
      staleNote="The queue changed since this brief"
      result={briefQuery.data ?? undefined}
      isLoadingCache={briefQuery.isLoading}
      isGenerating={generateMutation.isPending}
      error={generateMutation.error}
      onGenerate={() => generateMutation.mutate()}
      renderContent={(content) => (
        <div>
          <p className="text-sm leading-6 text-foreground">
            {content.headline}
          </p>
          <BriefEntryList
            entries={content.needsYou.map((entry) => ({
              pullRequestId: entry.pullRequestId,
              text: entry.why,
            }))}
            heading="Suggested order"
            itemById={itemById}
            ordered
          />
          <BriefEntryList
            entries={content.whileAway.map((entry) => ({
              pullRequestId: entry.pullRequestId,
              text: entry.note,
            }))}
            heading="While you were away"
            itemById={itemById}
          />
        </div>
      )}
    />
  )
}

function BriefEntryList({
  heading,
  entries,
  itemById,
  ordered = false,
}: {
  heading: string
  entries: Array<{ pullRequestId: string; text: string }>
  itemById: Map<string, ReviewQueueItemView>
  ordered?: boolean
}) {
  const linkable = entries.flatMap((entry) => {
    const item = itemById.get(entry.pullRequestId)
    return item ? [{ ...entry, item }] : []
  })
  if (linkable.length === 0) return null

  const ListTag = ordered ? "ol" : "ul"

  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-muted-foreground">
        {heading}
      </div>
      <ListTag className="mt-1.5 space-y-1.5 text-sm leading-5 text-foreground">
        {linkable.map((entry, index) => (
          <li key={entry.pullRequestId} className="flex gap-2">
            {ordered ? (
              <span className="mt-px w-4 shrink-0 text-right text-xs font-medium text-muted-foreground">
                {index + 1}.
              </span>
            ) : (
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            )}
            <span>
              <Link
                className="font-medium text-foreground underline-offset-2 hover:underline"
                params={{ pullRequestId: entry.pullRequestId }}
                to="/pull-requests/$pullRequestId"
              >
                {entry.item.repository}#{entry.item.number} ·{" "}
                {entry.item.title}
              </Link>{" "}
              <span className="text-muted-foreground">— {entry.text}</span>
            </span>
          </li>
        ))}
      </ListTag>
    </div>
  )
}
