import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  GitCommitHorizontal,
  GitPullRequest,
  Inbox,
  MessageSquareText,
  PanelRight,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { getReviewerInbox, markPullRequestSeen } from "@/api"
import { cn } from "@/lib/utils"
import {
  buildInboxView,
  type ReviewLaneId,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"

type LaneId = ReviewLaneId

type LocalQueueState = "snoozed" | "caught_up"

interface LaneDefinition {
  id: LaneId
  label: string
  tone: "hot" | "changed" | "quiet"
  defaultOpen: boolean
}

const lanes: LaneDefinition[] = [
  {
    id: "needs_review",
    label: "Needs your review",
    tone: "hot",
    defaultOpen: true,
  },
  {
    id: "updated_since_review",
    label: "Changed since you last looked",
    tone: "changed",
    defaultOpen: true,
  },
  {
    id: "waiting_on_author",
    label: "Waiting on author",
    tone: "quiet",
    defaultOpen: false,
  },
]

const laneToneClasses: Record<LaneDefinition["tone"], string> = {
  hot: "bg-[#d0a24c]",
  changed: "bg-[#9c8a60]",
  quiet: "bg-white/20",
}

const workflowLabels: Record<LaneId, string> = {
  needs_review: "Needs you",
  updated_since_review: "Changed since",
  waiting_on_author: "Waiting on author",
}

export function InboxPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inboxQuery = useQuery({
    queryKey: ["reviewer-inbox"],
    queryFn: getReviewerInbox,
  })
  const markSeenMutation = useMutation({
    mutationFn: markPullRequestSeen,
    onSuccess: async (_result, pullRequestId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["pull-request", pullRequestId] }),
      ])
    },
  })
  const [localQueueState, setLocalQueueState] = useState<
    Partial<Record<string, LocalQueueState>>
  >({})
  const inboxView = useMemo(
    () => (inboxQuery.data ? buildInboxView(inboxQuery.data) : undefined),
    [inboxQuery.data]
  )
  const activeItems = useMemo(
    () => inboxView?.items.filter((item) => !localQueueState[item.id]) ?? [],
    [inboxView, localQueueState]
  )
  const laneItems = useMemo(
    () =>
      lanes.reduce(
        (acc, lane) => {
          acc[lane.id] = activeItems.filter(
            (item) => item.laneId === lane.id
          )
          return acc
        },
        {} as Record<LaneId, ReviewQueueItemView[]>
      ),
    [activeItems]
  )
  const [openLaneIds, setOpenLaneIds] = useState<Set<LaneId>>(
    () => new Set(lanes.filter((lane) => lane.defaultOpen).map((lane) => lane.id))
  )
  const visibleItems = useMemo(
    () =>
      lanes.flatMap((lane) =>
        openLaneIds.has(lane.id) ? laneItems[lane.id] : []
      ),
    [laneItems, openLaneIds]
  )
  const [selectedId, setSelectedId] = useState<string>(
    () => visibleItems[0]?.id ?? activeItems[0]?.id ?? ""
  )
  const selectedItem =
    activeItems.find((item) => item.id === selectedId) ?? activeItems[0]

  useEffect(() => {
    if (!visibleItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleItems[0]?.id ?? activeItems[0]?.id ?? "")
    }
  }, [activeItems, selectedId, visibleItems])

  function moveSelectionAfterRemoving(itemId: string) {
    const currentIndex = visibleItems.findIndex((item) => item.id === itemId)
    const remainingVisible = visibleItems.filter((item) => item.id !== itemId)
    const nextVisible =
      remainingVisible[Math.min(currentIndex, remainingVisible.length - 1)]
    const nextActive = activeItems.find((item) => item.id !== itemId)
    setSelectedId(nextVisible?.id ?? nextActive?.id ?? "")
  }

  async function setSelectedQueueState(nextState: LocalQueueState) {
    if (!selectedItem) return
    const itemId = selectedItem.id
    if (nextState === "caught_up") {
      await markSeenMutation.mutateAsync(itemId)
    }
    setLocalQueueState((current) => ({ ...current, [itemId]: nextState }))
    moveSelectionAfterRemoving(itemId)
  }

  function openSelectedDetail() {
    if (!selectedItem) return
    void navigate({
      to: "/pull-requests/$pullRequestId",
      params: { pullRequestId: selectedItem.id },
    })
  }

  function openSelectedGitHub() {
    if (!selectedItem) return
    window.open(selectedItem.url, "_blank", "noreferrer")
  }

  function focusLane(laneId: LaneId) {
    setOpenLaneIds((current) => {
      if (current.has(laneId)) return current
      const next = new Set(current)
      next.add(laneId)
      return next
    })

    const firstLaneItem = laneItems[laneId][0]
    if (firstLaneItem) {
      setSelectedId(firstLaneItem.id)
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!["j", "k", "Enter", "e", "s", "c"].includes(event.key)) return
      const activeElement = document.activeElement
      const activeTag = activeElement?.tagName
      const isEditingText =
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        activeTag === "SELECT" ||
        activeElement?.getAttribute("contenteditable") === "true"
      if (isEditingText) return
      if (
        event.key === "Enter" &&
        (activeTag === "BUTTON" || activeTag === "A")
      ) {
        return
      }

      event.preventDefault()

      if (event.key === "j" || event.key === "k") {
        setSelectedId((currentId) => {
          const currentIndex = visibleItems.findIndex(
            (item) => item.id === currentId
          )
          if (currentIndex < 0) return visibleItems[0]?.id ?? currentId
          const direction = event.key === "j" ? 1 : -1
          const nextIndex = Math.min(
            visibleItems.length - 1,
            Math.max(0, currentIndex + direction)
          )
          return visibleItems[nextIndex]?.id ?? currentId
        })
        return
      }

      if (event.key === "Enter") {
        openSelectedDetail()
        return
      }

      if (event.key === "e") {
        openSelectedGitHub()
        return
      }

      void setSelectedQueueState(event.key === "s" ? "snoozed" : "caught_up")
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [openSelectedDetail, selectedItem, visibleItems, markSeenMutation])

  if (inboxQuery.isLoading) {
    return <InboxStatusPanel title="Loading review inbox" />
  }

  if (inboxQuery.isError || !inboxView) {
    return (
      <InboxStatusPanel
        title="Could not load review inbox"
        detail="The API is not reachable. Start the full app with the API server, then reload."
      />
    )
  }

  return (
    <div className="grid min-h-[760px] grid-cols-1 sm:grid-cols-[190px_1fr] lg:grid-cols-[212px_1fr]">
      <InboxSidebar
        laneItems={laneItems}
        activeLaneId={lanes.find((lane) => lane.id === selectedItem?.laneId)?.id}
        approvedCount={inboxView.approvedCount}
        watchingCount={inboxView.watchingCount}
        snoozedCount={
          inboxView.items.filter(
            (item) => localQueueState[item.id] === "snoozed"
          ).length
        }
        onSelectLane={focusLane}
      />

      <section className="flex min-w-0 flex-col bg-[#242420]">
        <InboxHeader />
        <div className="grid min-h-[697px] grid-cols-1 xl:grid-cols-[58fr_42fr]">
          <div className="min-w-0 border-b border-white/10 xl:border-r xl:border-b-0">
            <div className="h-full overflow-y-auto pt-2 pb-7">
              {lanes.map((lane) => (
                <QueueLane
                  key={lane.id}
                  lane={lane}
                  isOpen={openLaneIds.has(lane.id)}
                  items={laneItems[lane.id]}
                  selectedId={selectedItem?.id ?? ""}
                  onToggle={() => {
                    setOpenLaneIds((current) => {
                      const next = new Set(current)
                      if (next.has(lane.id)) {
                        next.delete(lane.id)
                      } else {
                        next.add(lane.id)
                      }
                      return next
                    })
                  }}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          </div>
          {selectedItem ? (
            <QuickPeekPanel
              item={selectedItem}
              isMarkingSeen={markSeenMutation.isPending}
              onSnooze={() => void setSelectedQueueState("snoozed")}
              onCaughtUp={() => void setSelectedQueueState("caught_up")}
            />
          ) : (
            <EmptyPeekPanel />
          )}
        </div>
      </section>
    </div>
  )
}

function InboxSidebar({
  laneItems,
  activeLaneId,
  approvedCount,
  watchingCount,
  snoozedCount,
  onSelectLane,
}: {
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  activeLaneId?: LaneId
  approvedCount: number
  watchingCount: number
  snoozedCount: number
  onSelectLane: (laneId: LaneId) => void
}) {
  return (
    <aside className="flex flex-col border-b border-white/10 bg-[#191916] px-3 py-4 sm:border-r sm:border-b-0">
      <div className="flex items-center gap-2 px-2 pt-1 pb-4">
        <div className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-[#d0a24c] text-[9px] font-bold text-[#191916]">
          R
        </div>
        <div className="font-mono text-[11px] tracking-[0.14em] text-[#f0ede4] uppercase">
          Review Q
        </div>
      </div>
      <SidebarSection label="Review buckets">
        <SidebarItem
          active={activeLaneId === "needs_review"}
          attention={laneItems.needs_review.length > 0}
          label={workflowLabels.needs_review}
          count={laneItems.needs_review.length}
          onClick={() => onSelectLane("needs_review")}
        />
        <SidebarItem
          active={activeLaneId === "updated_since_review"}
          attention={laneItems.updated_since_review.length > 0}
          label={workflowLabels.updated_since_review}
          count={laneItems.updated_since_review.length}
          onClick={() => onSelectLane("updated_since_review")}
        />
        <SidebarItem
          active={activeLaneId === "waiting_on_author"}
          attention={laneItems.waiting_on_author.length > 0}
          label={workflowLabels.waiting_on_author}
          count={laneItems.waiting_on_author.length}
          onClick={() => onSelectLane("waiting_on_author")}
        />
        <SidebarItem label="Approved · recent" count={approvedCount} />
      </SidebarSection>
      <SidebarSection label="Stashed">
        <SidebarItem label="Snoozed" count={snoozedCount} />
        <SidebarItem label="Watching" count={watchingCount} />
      </SidebarSection>
      <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-5 text-[#8e8b82] sm:mt-auto">
        Review decisions still happen in GitHub. This surface only tracks where
        your attention belongs.
      </div>
    </aside>
  )
}

function InboxStatusPanel({
  title,
  detail,
}: {
  title: string
  detail?: string
}) {
  return (
    <div className="grid min-h-[760px] place-items-center bg-[#242420] px-6">
      <div className="max-w-sm rounded-lg border border-white/10 bg-[#20201d] p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-[#d0a24c]">
          <Inbox className="h-5 w-5" />
        </div>
        <h1 className="text-[18px] font-semibold tracking-tight text-[#f0ede4]">
          {title}
        </h1>
        {detail ? (
          <p className="mt-2 text-sm leading-6 text-[#9f9a91]">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

function SidebarSection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="px-2 pb-2 pt-3 font-mono text-[9.5px] tracking-[0.14em] text-[#77736a] uppercase">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function SidebarItem({
  label,
  count,
  active,
  attention,
  onClick,
}: {
  label: string
  count: number
  active?: boolean
  attention?: boolean
  onClick?: () => void
}) {
  const itemClassName = cn(
    "grid w-full grid-cols-[7px_1fr_auto] items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] text-[#a5a299]",
    active && "bg-white/[0.07] text-[#f0ede4]",
    onClick && !active && "hover:bg-white/[0.04]",
    !onClick && "cursor-default"
  )

  const content = (
    <>
      <span
        className={cn(
          "h-[7px] w-[7px] rounded-full bg-white/20",
          attention && "bg-[#d0a24c]"
        )}
      />
      <span className={cn(attention && "font-medium text-[#f0ede4]")}>{label}</span>
      <span
        className={cn(
          "font-mono text-[11px] text-[#77736a]",
          attention &&
            "rounded-full bg-[#d0a24c] px-2 py-[1px] font-semibold text-[#191916]"
        )}
      >
        {count}
      </span>
    </>
  )

  if (!onClick) {
    return <div className={itemClassName}>{content}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={itemClassName}
    >
      {content}
    </button>
  )
}

function InboxHeader() {
  return (
    <div className="flex h-[62px] items-center border-b border-white/10 px-5">
      <h1 className="text-[17px] font-semibold tracking-tight">Review Inbox</h1>
      <span className="ml-4 font-mono text-[11px] text-[#8e8b82]">
        · synced 2m ago
      </span>
      <div className="ml-auto inline-flex h-8 items-center rounded-md border border-white/10 px-3 font-mono text-[11px] text-[#c9c5ba]">
        group: action
      </div>
      <div className="ml-3 hidden items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-[#8e8b82] uppercase lg:flex">
        <Kbd>j</Kbd>
        <span>/</span>
        <Kbd>k</Kbd>
        <span>to move</span>
      </div>
    </div>
  )
}

function QueueLane({
  lane,
  isOpen,
  items,
  selectedId,
  onToggle,
  onSelect,
}: {
  lane: LaneDefinition
  isOpen: boolean
  items: ReviewQueueItemView[]
  selectedId: string
  onToggle: () => void
  onSelect: (id: string) => void
}) {
  return (
    <section className="border-b border-white/10 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-3 px-5 py-3 text-left"
      >
        <span className={cn("h-5 w-1 rounded-full", laneToneClasses[lane.tone])} />
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-[#77736a]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[#77736a]" />
        )}
        <span className="font-mono text-[11px] tracking-[0.12em] text-[#b7b2a7] uppercase">
          {lane.label}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-full border-white/10 bg-transparent px-2 font-mono text-[11px] text-[#8e8b82]",
            lane.tone === "hot" && "border-[#d0a24c] bg-[#d0a24c] text-[#191916]"
          )}
        >
          {items.length}
        </Badge>
      </button>
      {isOpen && (
        <div>
          {items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={() => onSelect(item.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function QueueRow({
  item,
  selected,
  onSelect,
}: {
  item: ReviewQueueItemView
  selected: boolean
  onSelect: () => void
}) {
  const initials = item.authorLogin.slice(0, 2).toUpperCase()
  const reReviewRequested = item.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "relative grid w-full grid-cols-[26px_1fr_auto] items-center gap-3 border-t border-white/10 px-5 py-3 text-left transition-colors hover:bg-white/[0.04]",
        selected && "bg-white/[0.07] shadow-[inset_3px_0_0_#d0a24c]"
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          item.waitingOn === "you" && "bg-[#d0a24c]",
          item.waitingOn === "author" && "bg-white/20",
          selected && "bg-[#d0a24c]"
        )}
      />
      <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-white/10 bg-white/[0.05] font-mono text-[10px] text-[#9f9a91]">
        {initials}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-[#eeeae0]">
            {item.title}
          </span>
          <span
            className={cn(
              "rounded-full border border-white/10 px-2 py-[1px] font-mono text-[9.5px] tracking-[0.06em] text-[#8e8b82] uppercase",
              item.waitingOn === "you" &&
                "border-[#d0a24c]/70 bg-[#d0a24c]/15 text-[#d0a24c]"
            )}
          >
            {item.waitingOn === "you" ? "you" : "author"}
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[#8e8b82]">
          <span className="text-[#bbb6ab]">
            {item.repository} / #{item.number}
          </span>
          <span className="text-white/20">·</span>
          <span>{item.authorLogin}</span>
          {item.newCommitCount > 0 ? (
            <FactChip icon={GitCommitHorizontal} text={`+${item.newCommitCount}`} active />
          ) : null}
          {item.newReplyCount > 0 ? (
            <FactChip icon={MessageSquareText} text={`${item.newReplyCount}`} active />
          ) : null}
          {item.totalThreadCount > 0 ? (
            <FactChip
              icon={Inbox}
              text={`${item.unresolvedThreadCount}/${item.totalThreadCount}`}
              active={item.unresolvedThreadCount > 0}
            />
          ) : null}
          {reReviewRequested ? <FactChip icon={Eye} text="review req" active /> : null}
        </span>
      </span>
      <span className="flex min-w-[74px] flex-col items-end gap-1 font-mono">
        <span
          className={cn(
            "text-[12px] text-[#bdb8ad]",
            item.waitingOn === "you" && "font-semibold text-[#d0a24c]"
          )}
        >
          {item.waitingAge}
        </span>
        <span className="text-[9.5px] tracking-[0.08em] text-[#77736a] uppercase">
          {item.waitingOn === "you" ? "waiting on you" : "on author"}
        </span>
      </span>
    </button>
  )
}

function FactChip({
  icon: Icon,
  text,
  active,
}: {
  icon: ComponentType<{ className?: string }>
  text: string
  active?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] border border-white/10 bg-[#1d1d1a] px-1.5 py-[1px] text-[10.5px] text-[#8e8b82]",
        active && "border-[#d0a24c]/50 bg-[#d0a24c]/12 text-[#d0a24c]"
      )}
    >
      <Icon className="h-3 w-3" />
      {text}
    </span>
  )
}

function QuickPeekPanel({
  item,
  isMarkingSeen,
  onSnooze,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  isMarkingSeen: boolean
  onSnooze: () => void
  onCaughtUp: () => void
}) {
  const reReviewRequested = item.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )
  const factRows = [
    {
      id: "commits",
      label: `+${item.newCommitCount} new commits`,
      show: item.newCommitCount > 0,
    },
    {
      id: "replies",
      label: `${item.newReplyCount} new replies on threads you opened`,
      show: item.newReplyCount > 0,
    },
    {
      id: "review",
      label: "review requested",
      show: reReviewRequested,
    },
  ].filter((row) => row.show)
  const hasBodySections =
    item.totalThreadCount > 0 || item.changedFilesSinceLastSeen.length > 0

  return (
    <aside className="flex min-h-[520px] min-w-0 flex-col bg-[#20201d]">
      <div className="border-b border-white/10 px-5 py-5">
        <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] text-[#8e8b82] uppercase">
          <PanelRight className="h-3.5 w-3.5" />
          Quick peek · no need to open
        </div>
        <h2 className="mt-3 text-[20px] font-semibold leading-7 tracking-tight text-[#f0ede4]">
          {item.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#8e8b82]">
          <span>
            {item.repository} / #{item.number}
          </span>
          <span className="text-white/20">·</span>
          <span>{item.authorLogin}</span>
          <span className="text-white/20">·</span>
          <span className={cn(item.waitingOn === "you" && "text-[#d0a24c]")}>
            {item.waitingOn === "you" ? "waiting on you" : "waiting on author"}{" "}
            {item.waitingAge}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <section className="rounded-md border border-[#d0a24c]/30 bg-[#d0a24c]/10 p-4">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] text-[#d0a24c] uppercase">
            <Clock3 className="h-3.5 w-3.5" />
            Since your last visit · {item.lastSeenAt}
          </div>
          <ul className="mt-3 space-y-2 text-[13px] leading-5 text-[#ded9ce]">
            {factRows.length > 0 ? factRows.map((row) => (
              <li key={row.id} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#d0a24c]" />
                <span>{row.label}</span>
              </li>
            )) : (
              <li className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-white/30" />
                <span>No unseen activity since your last visit.</span>
              </li>
            )}
          </ul>
        </section>

        <Separator className="my-5 bg-white/10" />

        <section>
          <div className="font-mono text-[11px] tracking-[0.1em] text-[#9f9a91] uppercase">
            Queue reason
          </div>
          <div className="mt-3 rounded-md border border-white/10 bg-white/[0.03] p-3 text-[13px] leading-5 text-[#d8d3c8]">
            {item.reason}
          </div>
        </section>

        {item.activityEvents.length > 0 ? (
          <>
            <Separator className="my-5 bg-white/10" />
            <section>
              <div className="font-mono text-[11px] tracking-[0.1em] text-[#9f9a91] uppercase">
                Latest activity
              </div>
              <div className="mt-3 space-y-2">
                {item.activityEvents.slice(0, 3).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-[12.5px] leading-5 text-[#d8d3c8]"
                  >
                    <div>
                      <b>{event.actor}</b> {event.action}
                    </div>
                    <div className="mt-1 font-mono text-[10px] tracking-[0.06em] text-[#77736a] uppercase">
                      {event.occurredAt}
                      {event.isNew ? " · new" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}

        {hasBodySections ? <Separator className="my-5 bg-white/10" /> : null}

        {item.totalThreadCount > 0 ? (
          <section>
            <div className="font-mono text-[11px] tracking-[0.1em] text-[#9f9a91] uppercase">
              Open threads · {item.unresolvedThreadCount} of{" "}
              {item.totalThreadCount} unresolved
            </div>
            <div className="mt-3 space-y-2">
              {item.reviewThreads.map((thread) => (
                <div
                  key={thread.id}
                  className="grid grid-cols-[30px_1fr] gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3"
                >
                  <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-white/10 bg-white/[0.04] font-mono text-[10px] text-[#9f9a91]">
                    {thread.author.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-[12.5px] leading-5 text-[#d8d3c8]">
                      {thread.excerpt}
                    </div>
                    <div
                      className={cn(
                        "mt-1.5 font-mono text-[10px] tracking-[0.06em] uppercase",
                        thread.status === "unresolved"
                          ? "text-[#d0a24c]"
                          : "text-[#77736a]"
                      )}
                    >
                      {thread.status}
                      {thread.authorReplied ? " · author replied" : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {item.totalThreadCount > 0 && item.changedFilesSinceLastSeen.length > 0 ? (
          <Separator className="my-5 bg-white/10" />
        ) : null}

        {item.changedFilesSinceLastSeen.length > 0 ? <section>
          <div className="font-mono text-[11px] tracking-[0.1em] text-[#9f9a91] uppercase">
            Files touched since last look · {item.changedFilesSinceLastSeen.length}
          </div>
          <div className="mt-3 space-y-1">
            {item.changedFilesSinceLastSeen.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-4 rounded-[4px] px-2 py-1.5 font-mono text-[11px] text-[#bdb8ad] hover:bg-white/[0.03]"
              >
                <span className="truncate">{file.path}</span>
                <span className="text-[#8e8b82]">
                  +{file.additions} / -{file.deletions}
                </span>
              </div>
            ))}
          </div>
        </section> : null}
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-white/10 px-5 py-4">
        <Button
          asChild
          className="h-9 flex-1 bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f]"
        >
          <a href={item.url} target="_blank" rel="noreferrer">
            Open in GitHub to review
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onSnooze}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Clock3 className="h-4 w-4" />
          Snooze
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCaughtUp}
          disabled={isMarkingSeen}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Check className="h-4 w-4" />
          {isMarkingSeen ? "Saving" : "Caught up"}
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-[#9f9a91] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Link to="/pull-requests/$pullRequestId" params={{ pullRequestId: item.id }}>
            <span className="sr-only">Open PR detail</span>
            <GitPullRequest className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </aside>
  )
}

function EmptyPeekPanel() {
  return (
    <aside className="flex min-w-0 flex-col items-center justify-center bg-[#20201d] px-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[#d0a24c]">
        <Check className="h-5 w-5" />
      </div>
      <h2 className="mt-5 text-[18px] font-semibold tracking-tight text-[#f0ede4]">
        No active review items
      </h2>
      <p className="mt-2 max-w-[300px] text-sm leading-6 text-[#9f9a91]">
        Everything in this local queue has been snoozed or marked caught up.
      </p>
    </aside>
  )
}
