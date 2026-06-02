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
  BellOff,
  GitCommitHorizontal,
  GitPullRequest,
  Inbox,
  MessageSquareText,
  PanelRight,
  Pin,
  RotateCcw,
  Search,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { getReviewerInbox, markPullRequestSeen } from "@/api"
import { formatCount } from "@/lib/copy"
import { cn } from "@/lib/utils"
import {
  buildInboxView,
  type ReviewQueueBucketId,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import {
  hasLocalQueueState,
  loadLocalQueueState,
  saveLocalQueueState,
  type LocalPullRequestQueueState,
  type LocalQueueStateByPullRequestId,
} from "@/reviewer/local-queue-state"

type LaneId = ReviewQueueBucketId

type QueueGroupMode = "action" | "repository" | "pinned" | "snoozed" | "muted"

interface LaneDefinition {
  id: LaneId
  label: string
  tone: "hot" | "changed" | "quiet"
  defaultOpen: boolean
}

interface QueueGroupDefinition {
  id: string
  label: string
  tone: LaneDefinition["tone"]
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
  {
    id: "approved",
    label: "Approved recently",
    tone: "quiet",
    defaultOpen: false,
  },
  {
    id: "watching",
    label: "Watching / stale",
    tone: "quiet",
    defaultOpen: false,
  },
]

const laneToneClasses: Record<LaneDefinition["tone"], string> = {
  hot: "bg-[#d0a24c]",
  changed: "bg-[#9c8a60]",
  quiet: "bg-white/20",
}

const primaryQueueLaneIds: LaneId[] = [
  "needs_review",
  "updated_since_review",
  "waiting_on_author",
]

const workflowLabels: Record<LaneId, string> = {
  needs_review: "Needs you",
  updated_since_review: "Changed since",
  waiting_on_author: "Waiting on author",
  approved: "Approved · recent",
  watching: "Watching / stale",
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
  const [localQueueState, setLocalQueueState] =
    useState<LocalQueueStateByPullRequestId>(() => {
      if (typeof window === "undefined") return {}
      return loadLocalQueueState(window.localStorage)
    })
  const [failedCaughtUpItemId, setFailedCaughtUpItemId] = useState<string>()
  const [groupMode, setGroupMode] = useState<QueueGroupMode>("action")
  const [searchQuery, setSearchQuery] = useState("")
  const inboxView = useMemo(
    () => (inboxQuery.data ? buildInboxView(inboxQuery.data) : undefined),
    [inboxQuery.data]
  )
  const activeItems = useMemo(
    () =>
      inboxView?.items.filter((item) => {
        const itemState = localQueueState[item.id]
        return !itemState?.snoozed && !itemState?.muted
      }) ?? [],
    [inboxView, localQueueState]
  )
  const pinnedItems = useMemo(
    () =>
      inboxView?.items.filter((item) => {
        const itemState = localQueueState[item.id]
        return Boolean(itemState?.pinned && !itemState.snoozed && !itemState.muted)
      }) ?? [],
    [inboxView, localQueueState]
  )
  const snoozedItems = useMemo(
    () =>
      inboxView?.items.filter(
        (item) => localQueueState[item.id]?.snoozed
      ) ?? [],
    [inboxView, localQueueState]
  )
  const mutedItems = useMemo(
    () =>
      inboxView?.items.filter((item) => localQueueState[item.id]?.muted) ?? [],
    [inboxView, localQueueState]
  )
  const searchedActiveItems = useMemo(
    () => filterQueueItems(activeItems, searchQuery),
    [activeItems, searchQuery]
  )
  const searchedPinnedItems = useMemo(
    () => filterQueueItems(pinnedItems, searchQuery),
    [pinnedItems, searchQuery]
  )
  const searchedSnoozedItems = useMemo(
    () => filterQueueItems(snoozedItems, searchQuery),
    [snoozedItems, searchQuery]
  )
  const searchedMutedItems = useMemo(
    () => filterQueueItems(mutedItems, searchQuery),
    [mutedItems, searchQuery]
  )
  const laneItems = useMemo(
    () =>
      lanes.reduce(
        (acc, lane) => {
          acc[lane.id] = searchedActiveItems.filter(
            (item) => itemBelongsToBucket(item, lane.id)
          )
          return acc
        },
        {} as Record<LaneId, ReviewQueueItemView[]>
      ),
    [searchedActiveItems]
  )
  const [openLaneIds, setOpenLaneIds] = useState<Set<LaneId>>(
    () => new Set(lanes.filter((lane) => lane.defaultOpen).map((lane) => lane.id))
  )
  const actionQueueGroups = useMemo(
    () =>
      lanes.filter(
        (lane) =>
          primaryQueueLaneIds.includes(lane.id) ||
          laneItems[lane.id].length > 0 ||
          openLaneIds.has(lane.id)
      ),
    [laneItems, openLaneIds]
  )
  const visibleItems = useMemo(
    () =>
      actionQueueGroups.flatMap((lane) =>
        openLaneIds.has(lane.id) ? laneItems[lane.id] : []
      ),
    [actionQueueGroups, laneItems, openLaneIds]
  )
  const repositoryGroups = useMemo(
    () => buildRepositoryGroups(searchedActiveItems),
    [searchedActiveItems]
  )
  const [openRepositoryIds, setOpenRepositoryIds] = useState<Set<string>>(
    () => new Set()
  )
  const visibleRepositoryItems = useMemo(
    () =>
      repositoryGroups.flatMap((group) =>
        openRepositoryIds.has(group.id) ? group.items : []
      ),
    [openRepositoryIds, repositoryGroups]
  )
  const visibleQueueItems =
    groupMode === "action"
      ? visibleItems
      : groupMode === "repository"
        ? visibleRepositoryItems
        : groupMode === "pinned"
          ? searchedPinnedItems
          : groupMode === "snoozed"
            ? searchedSnoozedItems
            : searchedMutedItems
  const [selectedId, setSelectedId] = useState<string>(
    () => visibleQueueItems[0]?.id ?? activeItems[0]?.id ?? ""
  )
  const selectableItems =
    groupMode === "pinned"
      ? searchedPinnedItems
      : groupMode === "snoozed"
        ? searchedSnoozedItems
        : groupMode === "muted"
          ? searchedMutedItems
          : searchedActiveItems
  const selectedItem =
    selectableItems.find((item) => item.id === selectedId) ??
    selectableItems[0] ??
    searchedActiveItems[0] ??
    searchedPinnedItems[0] ??
    searchedSnoozedItems[0] ??
    searchedMutedItems[0]
  const selectedItemLocalState = selectedItem
    ? localQueueState[selectedItem.id] ?? {}
    : {}
  const selectedItemIsPinned = Boolean(selectedItemLocalState.pinned)
  const selectedItemIsSnoozed = Boolean(selectedItemLocalState.snoozed)
  const selectedItemIsMuted = Boolean(selectedItemLocalState.muted)

  useEffect(() => {
    saveLocalQueueState(window.localStorage, localQueueState)
  }, [localQueueState])

  useEffect(() => {
    if (groupMode !== "action") return
    if (visibleQueueItems.length > 0 || searchedActiveItems.length === 0) return

    const firstNonEmptyLane = lanes.find((lane) => laneItems[lane.id].length > 0)
    if (!firstNonEmptyLane) return

    setOpenLaneIds((current) => {
      if (current.has(firstNonEmptyLane.id)) return current
      const next = new Set(current)
      next.add(firstNonEmptyLane.id)
      return next
    })
  }, [groupMode, laneItems, searchedActiveItems.length, visibleQueueItems.length])

  useEffect(() => {
    if (groupMode !== "repository") return
    if (repositoryGroups.length === 0) return

    setOpenRepositoryIds((current) => {
      const repositoryIds = new Set(repositoryGroups.map((group) => group.id))
      const retainedIds = [...current].filter((id) => repositoryIds.has(id))
      const hasEveryRepositoryOpen =
        retainedIds.length === repositoryGroups.length &&
        retainedIds.every((id) => current.has(id))

      if (hasEveryRepositoryOpen) return current
      return new Set(repositoryGroups.map((group) => group.id))
    })
  }, [groupMode, repositoryGroups])

  useEffect(() => {
    if (!visibleQueueItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleQueueItems[0]?.id ?? selectableItems[0]?.id ?? "")
    }
  }, [selectableItems, selectedId, visibleQueueItems])

  function moveSelectionAfterHiding(itemId: string) {
    const currentIndex = visibleQueueItems.findIndex((item) => item.id === itemId)
    const remainingVisible = visibleQueueItems.filter((item) => item.id !== itemId)
    const nextVisible =
      remainingVisible[Math.min(currentIndex, remainingVisible.length - 1)]
    const nextActive = searchedActiveItems.find((item) => item.id !== itemId)

    if (!nextVisible && isStashedGroupMode(groupMode)) {
      setGroupMode("action")
    }

    setSelectedId(nextVisible?.id ?? nextActive?.id ?? "")
  }

  async function markSelectedCaughtUp() {
    if (!selectedItem) return
    const itemId = selectedItem.id
    setFailedCaughtUpItemId(undefined)
    markSeenMutation.reset()
    await markSeenMutation.mutateAsync(itemId).catch(() => {
      setFailedCaughtUpItemId(itemId)
    })
  }

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

  function snoozeSelected() {
    if (!selectedItem || selectedItemIsSnoozed) return
    const itemId = selectedItem.id
    updateLocalItemState(itemId, (current) => ({
      ...current,
      muted: undefined,
      snoozed: true,
    }))
    moveSelectionAfterHiding(itemId)
  }

  function restoreSelected() {
    if (!selectedItem || (!selectedItemIsSnoozed && !selectedItemIsMuted)) return
    const itemId = selectedItem.id
    updateLocalItemState(itemId, (current) => {
      const next = { ...current }
      delete next.snoozed
      delete next.muted
      return next
    })
    setGroupMode("action")
    setOpenLaneIds((current) => {
      const next = new Set(current)
      const restoredBucketId = bucketIdForItem(selectedItem)
      if (restoredBucketId) {
        next.add(restoredBucketId)
      }
      return next
    })
    setSelectedId(itemId)
  }

  function togglePinSelected() {
    if (!selectedItem || selectedItemIsSnoozed || selectedItemIsMuted) return
    const itemId = selectedItem.id
    updateLocalItemState(itemId, (current) => ({
      ...current,
      pinned: current.pinned ? undefined : true,
    }))
  }

  function muteSelected() {
    if (!selectedItem || selectedItemIsMuted) return
    const itemId = selectedItem.id
    updateLocalItemState(itemId, () => ({ muted: true }))
    moveSelectionAfterHiding(itemId)
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
    setGroupMode("action")
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

  function focusSnoozed() {
    if (searchedSnoozedItems.length === 0) return
    setGroupMode("snoozed")
    setSelectedId(searchedSnoozedItems[0]?.id ?? "")
  }

  function focusPinned() {
    if (searchedPinnedItems.length === 0) return
    setGroupMode("pinned")
    setSelectedId(searchedPinnedItems[0]?.id ?? "")
  }

  function focusMuted() {
    if (searchedMutedItems.length === 0) return
    setGroupMode("muted")
    setSelectedId(searchedMutedItems[0]?.id ?? "")
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!["j", "k", "Enter", "e", "s", "p", "m", "c", "/"].includes(event.key)) {
        return
      }
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

      if (event.key === "/") {
        document.getElementById("review-inbox-search")?.focus()
        return
      }

      if (event.key === "j" || event.key === "k") {
        setSelectedId((currentId) => {
          const keyboardItems = visibleQueueItems
          const currentIndex = keyboardItems.findIndex(
            (item) => item.id === currentId
          )
          if (currentIndex < 0) return keyboardItems[0]?.id ?? currentId
          const direction = event.key === "j" ? 1 : -1
          const nextIndex = Math.min(
            keyboardItems.length - 1,
            Math.max(0, currentIndex + direction)
          )
          return keyboardItems[nextIndex]?.id ?? currentId
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

      if (event.key === "s") {
        if (selectedItemIsSnoozed) {
          restoreSelected()
        } else if (!selectedItemIsMuted) {
          snoozeSelected()
        }
        return
      }

      if (event.key === "p") {
        togglePinSelected()
        return
      }

      if (event.key === "m") {
        if (selectedItemIsMuted) {
          restoreSelected()
        } else {
          muteSelected()
        }
        return
      }

      void markSelectedCaughtUp()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    openSelectedDetail,
    selectedItem,
    selectedItemIsMuted,
    selectedItemIsPinned,
    selectedItemIsSnoozed,
    visibleQueueItems,
    markSeenMutation,
  ])

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
        activeLaneId={
          isStashedGroupMode(groupMode) ? undefined : bucketIdForItem(selectedItem)
        }
        pinnedActive={groupMode === "pinned"}
        pinnedCount={searchedPinnedItems.length}
        snoozedActive={groupMode === "snoozed"}
        snoozedCount={searchedSnoozedItems.length}
        mutedActive={groupMode === "muted"}
        mutedCount={searchedMutedItems.length}
        onSelectLane={focusLane}
        onSelectPinned={focusPinned}
        onSelectSnoozed={focusSnoozed}
        onSelectMuted={focusMuted}
      />

      <section className="flex min-w-0 flex-col bg-[#242420]">
        <InboxHeader
          groupMode={groupMode}
          searchQuery={searchQuery}
          syncLabel={formatSyncLabel(inboxQuery.dataUpdatedAt)}
          onGroupModeChange={setGroupMode}
          onSearchQueryChange={setSearchQuery}
        />
        <div className="grid min-h-[697px] grid-cols-1 xl:grid-cols-[58fr_42fr]">
          <div className="min-w-0 border-b border-white/10 xl:border-r xl:border-b-0">
            <div className="h-full overflow-y-auto pt-2 pb-7">
              {groupMode === "action" ? (
                actionQueueGroups.map((lane) => (
                  <QueueLane
                    key={lane.id}
                    group={lane}
                    isOpen={openLaneIds.has(lane.id)}
                    items={laneItems[lane.id]}
                    selectedId={selectedItem?.id ?? ""}
                    onToggle={() => {
                      setOpenLaneIds((current) =>
                        toggleOpenGroup(current, lane.id)
                      )
                    }}
                    onSelect={setSelectedId}
                  />
                ))
              ) : groupMode === "repository" ? (
                repositoryGroups.map((group) => (
                  <QueueLane
                    key={group.id}
                    group={group}
                    isOpen={openRepositoryIds.has(group.id)}
                    items={group.items}
                    selectedId={selectedItem?.id ?? ""}
                    onToggle={() => {
                      setOpenRepositoryIds((current) =>
                        toggleOpenGroup(current, group.id)
                      )
                    }}
                    onSelect={setSelectedId}
                  />
                ))
              ) : groupMode === "pinned" ? (
                <QueueLane
                  group={{ id: "pinned", label: "Pinned", tone: "changed" }}
                  isOpen
                  items={pinnedItems}
                  selectedId={selectedItem?.id ?? ""}
                  onToggle={() => undefined}
                  onSelect={setSelectedId}
                />
              ) : groupMode === "snoozed" ? (
                <QueueLane
                  group={{ id: "snoozed", label: "Snoozed", tone: "quiet" }}
                  isOpen
                  items={snoozedItems}
                  selectedId={selectedItem?.id ?? ""}
                  onToggle={() => undefined}
                  onSelect={setSelectedId}
                />
              ) : (
                <QueueLane
                  group={{ id: "muted", label: "Muted", tone: "quiet" }}
                  isOpen
                  items={mutedItems}
                  selectedId={selectedItem?.id ?? ""}
                  onToggle={() => undefined}
                  onSelect={setSelectedId}
                />
              )}
            </div>
          </div>
          {selectedItem ? (
            <QuickPeekPanel
              item={selectedItem}
              isPinned={selectedItemIsPinned}
              isSnoozed={selectedItemIsSnoozed}
              isMuted={selectedItemIsMuted}
              isMarkingSeen={markSeenMutation.isPending}
              caughtUpError={failedCaughtUpItemId === selectedItem.id}
              onSnooze={snoozeSelected}
              onRestore={restoreSelected}
              onTogglePin={togglePinSelected}
              onMute={muteSelected}
              onCaughtUp={() => void markSelectedCaughtUp()}
            />
          ) : (
            <EmptyPeekPanel hasSearchQuery={searchQuery.trim().length > 0} />
          )}
        </div>
      </section>
    </div>
  )
}

function InboxSidebar({
  laneItems,
  activeLaneId,
  pinnedActive,
  pinnedCount,
  snoozedActive,
  snoozedCount,
  mutedActive,
  mutedCount,
  onSelectLane,
  onSelectPinned,
  onSelectSnoozed,
  onSelectMuted,
}: {
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  activeLaneId?: LaneId
  pinnedActive: boolean
  pinnedCount: number
  snoozedActive: boolean
  snoozedCount: number
  mutedActive: boolean
  mutedCount: number
  onSelectLane: (laneId: LaneId) => void
  onSelectPinned: () => void
  onSelectSnoozed: () => void
  onSelectMuted: () => void
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
          onClick={
            laneItems.needs_review.length > 0
              ? () => onSelectLane("needs_review")
              : undefined
          }
        />
        <SidebarItem
          active={activeLaneId === "updated_since_review"}
          attention={laneItems.updated_since_review.length > 0}
          label={workflowLabels.updated_since_review}
          count={laneItems.updated_since_review.length}
          onClick={
            laneItems.updated_since_review.length > 0
              ? () => onSelectLane("updated_since_review")
              : undefined
          }
        />
        <SidebarItem
          active={activeLaneId === "waiting_on_author"}
          attention={laneItems.waiting_on_author.length > 0}
          label={workflowLabels.waiting_on_author}
          count={laneItems.waiting_on_author.length}
          onClick={
            laneItems.waiting_on_author.length > 0
              ? () => onSelectLane("waiting_on_author")
              : undefined
          }
        />
        <SidebarItem
          active={activeLaneId === "approved"}
          label={workflowLabels.approved}
          count={laneItems.approved.length}
          onClick={
            laneItems.approved.length > 0
              ? () => onSelectLane("approved")
              : undefined
          }
        />
      </SidebarSection>
      <SidebarSection label="Stashed">
        <SidebarItem
          active={pinnedActive}
          attention={pinnedCount > 0}
          label="Pinned"
          count={pinnedCount}
          onClick={pinnedCount > 0 ? onSelectPinned : undefined}
        />
        <SidebarItem
          active={snoozedActive}
          attention={snoozedCount > 0}
          label="Snoozed"
          count={snoozedCount}
          onClick={snoozedCount > 0 ? onSelectSnoozed : undefined}
        />
        <SidebarItem
          active={mutedActive}
          label="Muted"
          count={mutedCount}
          onClick={mutedCount > 0 ? onSelectMuted : undefined}
        />
        <SidebarItem
          active={activeLaneId === "watching"}
          label="Watching"
          count={laneItems.watching.length}
          onClick={
            laneItems.watching.length > 0
              ? () => onSelectLane("watching")
              : undefined
          }
        />
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

function InboxHeader({
  groupMode,
  searchQuery,
  syncLabel,
  onGroupModeChange,
  onSearchQueryChange,
}: {
  groupMode: QueueGroupMode
  searchQuery: string
  syncLabel: string
  onGroupModeChange: (mode: QueueGroupMode) => void
  onSearchQueryChange: (query: string) => void
}) {
  return (
    <div className="flex min-h-[62px] flex-wrap items-center gap-3 border-b border-white/10 px-5 py-2">
      <h1 className="text-[17px] font-semibold tracking-tight">Review Inbox</h1>
      <span className="font-mono text-[11px] text-[#8e8b82]">
        · {syncLabel}
      </span>
      <label
        htmlFor="review-inbox-search"
        className="ml-auto flex h-8 min-w-[220px] max-w-[360px] flex-1 items-center gap-2 rounded-md border border-white/10 bg-[#1f1f1c] px-2.5 text-[#8e8b82] focus-within:border-[#d0a24c]/70"
      >
        <Search className="h-3.5 w-3.5" />
        <input
          id="review-inbox-search"
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search PRs, repos, authors"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[#f0ede4] outline-none placeholder:text-[#77736a]"
        />
        <Kbd>/</Kbd>
      </label>
      <div
        className="inline-flex h-8 items-center gap-1 rounded-md border border-white/10 p-1 font-mono text-[11px] text-[#c9c5ba]"
        role="group"
        aria-label="Group pull requests"
      >
        <span className="px-2 text-[#8e8b82]">group:</span>
        <GroupModeButton
          active={groupMode === "action"}
          onClick={() => onGroupModeChange("action")}
        >
          action
        </GroupModeButton>
        <GroupModeButton
          active={groupMode === "repository"}
          onClick={() => onGroupModeChange("repository")}
        >
          repo
        </GroupModeButton>
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

function GroupModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 rounded-[4px] px-2 text-[#8e8b82] hover:bg-white/[0.04] hover:text-[#f0ede4]",
        active && "bg-[#d0a24c] font-semibold text-[#191916] hover:bg-[#d0a24c] hover:text-[#191916]"
      )}
    >
      {children}
    </button>
  )
}

function formatSyncLabel(dataUpdatedAt: number): string {
  if (!dataUpdatedAt) return "not synced"

  const elapsedMs = Math.max(0, Date.now() - dataUpdatedAt)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return "synced just now"
  if (minutes < 60) return `synced ${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `synced ${hours}h ago`

  return `synced ${Math.floor(hours / 24)}d ago`
}

function QueueLane({
  group,
  isOpen,
  items,
  selectedId,
  onToggle,
  onSelect,
}: {
  group: QueueGroupDefinition
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
        <span className={cn("h-5 w-1 rounded-full", laneToneClasses[group.tone])} />
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-[#77736a]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[#77736a]" />
        )}
        <span className="font-mono text-[11px] tracking-[0.12em] text-[#b7b2a7] uppercase">
          {group.label}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-full border-white/10 bg-transparent px-2 font-mono text-[11px] text-[#8e8b82]",
            group.tone === "hot" && "border-[#d0a24c] bg-[#d0a24c] text-[#191916]"
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
            {queuePillLabel(item)}
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
          {queueTimingLabel(item)}
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
  isPinned,
  isSnoozed,
  isMuted,
  isMarkingSeen,
  caughtUpError,
  onSnooze,
  onRestore,
  onTogglePin,
  onMute,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  isPinned: boolean
  isSnoozed: boolean
  isMuted: boolean
  isMarkingSeen: boolean
  caughtUpError: boolean
  onSnooze: () => void
  onRestore: () => void
  onTogglePin: () => void
  onMute: () => void
  onCaughtUp: () => void
}) {
  const reReviewRequested = item.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )
  const factRows = [
    {
      id: "commits",
      label: `+${formatCount(item.newCommitCount, "new commit")}`,
      show: item.newCommitCount > 0,
    },
    {
      id: "replies",
      label: `${formatCount(item.newReplyCount, "new reply", "new replies")} on threads you opened`,
      show: item.newReplyCount > 0,
    },
    {
      id: "review",
      label: "review requested",
      show: reReviewRequested,
    },
  ].filter((row) => row.show)
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
            {queueTimingLabel(item)} {item.waitingAge}
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
            Open threads · {item.unresolvedThreadCount} of{" "}
            {item.totalThreadCount} unresolved
          </div>
          <div className="mt-3 space-y-2">
            {item.reviewThreads.length > 0 ? item.reviewThreads.map((thread) => (
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
            )) : (
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-[12.5px] leading-5 text-[#8e8b82]">
                No open review threads.
              </div>
            )}
          </div>
        </section>

        {item.changedFilesSinceLastSeen.length > 0 ? (
          <Separator className="my-5 bg-white/10" />
        ) : null}

        {item.changedFilesSinceLastSeen.length > 0 ? (
          <section>
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
          </section>
        ) : null}

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
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2 border-t border-white/10 px-5 py-4 min-[1420px]:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        {caughtUpError ? (
          <div className="col-span-2 rounded-md border border-[#d0a24c]/30 bg-[#d0a24c]/10 px-3 py-2 text-[12px] leading-5 text-[#d8d3c8] min-[1420px]:col-span-5">
            Could not save caught-up state. Try again.
          </div>
        ) : null}
        <Button
          asChild
          className="col-span-2 h-9 bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f] min-[1420px]:col-span-5"
        >
          <a href={item.url} target="_blank" rel="noreferrer">
            Open in GitHub to review
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={isSnoozed ? onRestore : onSnooze}
          disabled={isMuted}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
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
          onClick={onTogglePin}
          disabled={isSnoozed || isMuted}
          aria-pressed={isPinned}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Pin className="h-4 w-4" />
          {isPinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={isMuted ? onRestore : onMute}
          disabled={isSnoozed}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <BellOff className="h-4 w-4" />
          {isMuted ? "Unmute" : "Mute"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCaughtUp}
          disabled={isMarkingSeen || item.unseenEventCount === 0}
          className="h-9 border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Check className="h-4 w-4" />
          {isMarkingSeen
            ? "Saving"
            : item.unseenEventCount === 0
              ? "All caught up"
              : "Caught up"}
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-9 w-full text-[#9f9a91] hover:bg-white/[0.04] hover:text-[#f0ede4] min-[1420px]:w-9"
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

function queuePillLabel(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") return "you"
  if (item.waitingOn === "author") return "author"
  if (item.laneId === "approved") return "approved"
  if (item.laneId === "caught_up") return "caught up"
  if (item.laneId === "stale") return "stale"
  return "watching"
}

function queueTimingLabel(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") return "waiting on you"
  if (item.waitingOn === "author") return "on author"
  if (item.laneId === "approved") return "approved"
  if (item.laneId === "caught_up") return "caught up"
  if (item.laneId === "stale") return "stale"
  return "watching"
}

function bucketIdForItem(
  item: ReviewQueueItemView | undefined
): LaneId | undefined {
  if (!item) return undefined
  if (item.laneId === "caught_up" || item.laneId === "stale") {
    return "watching"
  }
  return item.laneId
}

function isStashedGroupMode(groupMode: QueueGroupMode): boolean {
  return groupMode === "pinned" || groupMode === "snoozed" || groupMode === "muted"
}

function itemBelongsToBucket(
  item: ReviewQueueItemView,
  bucketId: LaneId
): boolean {
  if (bucketId === "watching") {
    return (
      item.laneId === "caught_up" ||
      item.laneId === "watching" ||
      item.laneId === "stale"
    )
  }

  return item.laneId === bucketId
}

function buildRepositoryGroups(
  items: ReviewQueueItemView[]
): Array<QueueGroupDefinition & { items: ReviewQueueItemView[] }> {
  const groups = new Map<
    string,
    QueueGroupDefinition & { items: ReviewQueueItemView[] }
  >()

  for (const item of items) {
    const existingGroup = groups.get(item.repository)

    if (existingGroup) {
      existingGroup.items.push(item)
      existingGroup.tone = strongerTone(existingGroup.tone, toneForItem(item))
      continue
    }

    groups.set(item.repository, {
      id: item.repository,
      label: item.repository,
      tone: toneForItem(item),
      items: [item],
    })
  }

  return [...groups.values()]
}

export function filterQueueItems(
  items: ReviewQueueItemView[],
  query: string
): ReviewQueueItemView[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return items

  return items.filter((item) =>
    buildSearchTextForItem(item).includes(normalizedQuery)
  )
}

function buildSearchTextForItem(item: ReviewQueueItemView): string {
  return normalizeSearchText(
    [
      item.title,
      item.repository,
      `#${item.number}`,
      String(item.number),
      item.authorLogin,
      item.reason,
      item.workflowState,
      item.userLastReviewDecision,
      ...item.activityEvents.flatMap((event) => [
        event.actor,
        event.action,
        event.detail ?? "",
      ]),
      ...item.reviewThreads.map((thread) => thread.excerpt),
    ].join(" ")
  )
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

function toneForItem(item: ReviewQueueItemView): LaneDefinition["tone"] {
  if (item.waitingOn === "you") return "hot"
  if (item.laneId === "updated_since_review") return "changed"
  return "quiet"
}

function strongerTone(
  current: LaneDefinition["tone"],
  next: LaneDefinition["tone"]
): LaneDefinition["tone"] {
  if (current === "hot" || next === "hot") return "hot"
  if (current === "changed" || next === "changed") return "changed"
  return "quiet"
}

function toggleOpenGroup<T extends string>(current: Set<T>, id: T): Set<T> {
  const next = new Set(current)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

function EmptyPeekPanel({ hasSearchQuery }: { hasSearchQuery: boolean }) {
  return (
    <aside className="flex min-w-0 flex-col items-center justify-center bg-[#20201d] px-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[#d0a24c]">
        <Check className="h-5 w-5" />
      </div>
      <h2 className="mt-5 text-[18px] font-semibold tracking-tight text-[#f0ede4]">
        {hasSearchQuery ? "No matching review items" : "No active review items"}
      </h2>
      <p className="mt-2 max-w-[300px] text-sm leading-6 text-[#9f9a91]">
        {hasSearchQuery
          ? "Adjust the search query to bring matching review items back into view."
          : "There are no active review items in the current view."}
      </p>
    </aside>
  )
}
