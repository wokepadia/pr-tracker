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
  type FormEvent,
  type ReactNode,
} from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Group as ResizablePanelGroup,
  Panel as ResizablePanel,
  Separator as ResizablePanelResizeHandle,
} from "react-resizable-panels"
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeftRight,
  Clock3,
  Edit3,
  ExternalLink,
  Eye,
  BellOff,
  GitCommitHorizontal,
  GitPullRequest,
  Inbox,
  LoaderCircle,
  MessageSquareText,
  PanelRight,
  Pin,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActivityEventLine } from "@/components/ActivityEventLine"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { MarkdownContent } from "@/components/MarkdownContent"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getReviewerInbox,
  markPullRequestSeen,
} from "@/api"
import { formatCount } from "@/lib/copy"
import { cn, externalLinkProps, openExternalLink } from "@/lib/utils"
import {
  buildInboxView,
  canMarkReviewItemCaughtUp,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import {
  bucketIdForLocalQueueItem,
  canMuteLocalQueueItem,
  canPinLocalQueueItem,
  canSnoozeLocalQueueItem,
  defaultUserBuckets,
  hasLocalQueueState,
  loadLocalQueueState,
  loadUserBucketLabels,
  saveLocalQueueState,
  saveUserBucketLabels,
  userBucketLabelFromId,
  type LocalPullRequestQueueState,
  type LocalQueueStateByPullRequestId,
  type UserBucketId,
  type UserBucketLabels,
} from "@/reviewer/local-queue-state"
import {
  filterQueueItems,
  getEmptyPeekCopy,
  loadStoredSelectedQueueItemId,
  resolveVisibleQueueItem,
  saveStoredSelectedQueueItemId,
  type QueueGroupMode,
} from "./inbox-helpers"

type LaneId = UserBucketId
type ActionQueueTabId = "home" | "new_activity" | LaneId

const REVIEW_QUEUE_MIN_WIDTH = 520
const QUICK_PEEK_MIN_WIDTH = 360
const REVIEW_SPLIT_HANDLE_WIDTH = 8
const REVIEW_WORKSPACE_MIN_WIDTH =
  REVIEW_QUEUE_MIN_WIDTH + QUICK_PEEK_MIN_WIDTH + REVIEW_SPLIT_HANDLE_WIDTH
const REVIEW_SIDEBAR_WIDTH = 212
const INBOX_LOADING_STEP_INTERVAL_MS = 1050
const githubReviewQueryStorageKey = "pr-tracker:github-review-query:v1"

function loadStoredGithubReviewQuery(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(githubReviewQueryStorageKey) ?? ""
}

function saveStoredGithubReviewQuery(query: string): void {
  window.localStorage.setItem(githubReviewQueryStorageKey, query)
}

interface LaneDefinition {
  id: LaneId
  label: string
  tone: "hot" | "changed" | "waiting" | "success" | "quiet"
  description?: string
}

interface InboxLoadingStep {
  label: string
  detail: string
  progress: string
}

interface QueueGroupDefinition {
  id: string
  label: string
  tone: LaneDefinition["tone"]
  description?: string
}

const laneDescriptions: Record<LaneId, string> = {
  inbox: "Default place for active PRs",
  reviewing: "PRs you are actively reviewing",
  waiting: "Waiting for another person",
  later: "Keep visible, lower urgency",
  done: "Finished or caught up",
}

const lanes: LaneDefinition[] = [
  {
    id: "inbox",
    label: "Inbox",
    tone: "hot",
    description: laneDescriptions.inbox,
  },
  {
    id: "reviewing",
    label: "Reviewing",
    tone: "changed",
    description: laneDescriptions.reviewing,
  },
  {
    id: "waiting",
    label: "Waiting",
    tone: "waiting",
    description: laneDescriptions.waiting,
  },
  {
    id: "later",
    label: "Later",
    tone: "quiet",
    description: laneDescriptions.later,
  },
  {
    id: "done",
    label: "Done",
    tone: "success",
    description: laneDescriptions.done,
  },
]

const laneToneClasses: Record<LaneDefinition["tone"], string> = {
  hot: "bg-amber-500",
  changed: "bg-sky-500",
  waiting: "bg-emerald-500",
  success: "bg-teal-500",
  quiet: "bg-slate-300",
}

const laneBadgeToneClasses: Record<LaneDefinition["tone"], string> = {
  hot: "border-amber-200 bg-amber-50 text-amber-800",
  changed: "border-sky-200 bg-sky-50 text-sky-800",
  waiting: "border-emerald-200 bg-emerald-50 text-emerald-800",
  success: "border-teal-200 bg-teal-50 text-teal-800",
  quiet: "border-border bg-muted/40 text-muted-foreground",
}

const rowSelectedToneClasses: Record<LaneDefinition["tone"], string> = {
  hot: "bg-amber-50/80 shadow-[inset_3px_0_0_#f59e0b]",
  changed: "bg-sky-50/80 shadow-[inset_3px_0_0_#0ea5e9]",
  waiting: "bg-emerald-50/80 shadow-[inset_3px_0_0_#10b981]",
  success: "bg-teal-50/80 shadow-[inset_3px_0_0_#14b8a6]",
  quiet: "bg-muted shadow-[inset_3px_0_0_#94a3b8]",
}

const inboxLoadingSteps: InboxLoadingStep[] = [
  {
    label: "Opening inbox request",
    detail: "Calling the local reviewer inbox endpoint.",
    progress: "Requesting /api/reviewer-inbox",
  },
  {
    label: "Checking GitHub source",
    detail: "Reading the configured token, viewer login, and repository scope.",
    progress: "Resolving local GitHub settings",
  },
  {
    label: "Identifying reviewer",
    detail: "Confirming which GitHub user the queue should be computed for.",
    progress: "Matching PR facts to the current reviewer",
  },
  {
    label: "Collecting pull requests",
    detail: "Scanning configured repositories for open reviewable PRs.",
    progress: "Fetching active pull request metadata",
  },
  {
    label: "Reading review history",
    detail: "Loading review decisions, comments, threads, and commits.",
    progress: "Fetching per-PR review activity",
  },
  {
    label: "Normalizing activity",
    detail: "Turning GitHub events into deterministic reviewer activity records.",
    progress: "Building ordered activity events",
  },
  {
    label: "Classifying queue state",
    detail: "Computing needs review, changed since, waiting, approved, and watching lanes.",
    progress: "Applying reviewer workflow rules",
  },
  {
    label: "Preparing workspace",
    detail: "Arranging lanes, quick peek context, and the initial keyboard selection.",
    progress: "Rendering the review inbox",
  },
]

export function InboxPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [githubSearchQueryDraft, setGithubSearchQueryDraft] = useState(() =>
    loadStoredGithubReviewQuery()
  )
  const [appliedGithubSearchQuery, setAppliedGithubSearchQuery] =
    useState<string | undefined>(() => loadStoredGithubReviewQuery() || undefined)
  const inboxQuery = useQuery({
    queryKey: ["reviewer-inbox", appliedGithubSearchQuery ?? ""],
    queryFn: () =>
      getReviewerInbox({ githubSearchQuery: appliedGithubSearchQuery }),
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
  const [userBucketLabels, setUserBucketLabels] = useState<UserBucketLabels>(() => {
    if (typeof window === "undefined") {
      return Object.fromEntries(
        defaultUserBuckets.map((bucket) => [bucket.id, bucket.label])
      ) as UserBucketLabels
    }
    return loadUserBucketLabels(window.localStorage)
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
  const newActivityItems = useMemo(
    () => activeItems.filter((item) => item.unseenEventCount > 0),
    [activeItems]
  )
  const searchedNewActivityItems = useMemo(
    () => filterQueueItems(newActivityItems, searchQuery),
    [newActivityItems, searchQuery]
  )
  const laneItems = useMemo(
    () =>
      lanes.reduce(
        (acc, lane) => {
          acc[lane.id] = searchedActiveItems.filter(
            (item) =>
              bucketIdForLocalQueueItem(localQueueState[item.id], item.laneId) ===
              lane.id
          )
          return acc
        },
        {} as Record<LaneId, ReviewQueueItemView[]>
      ),
    [localQueueState, searchedActiveItems]
  )
  const [activeActionTabId, setActiveActionTabId] =
    useState<ActionQueueTabId>("home")
  const visibleActionItems = useMemo(
    () =>
      activeActionTabId === "home"
        ? searchedActiveItems
        : activeActionTabId === "new_activity"
          ? searchedNewActivityItems
          : laneItems[activeActionTabId],
    [activeActionTabId, laneItems, searchedActiveItems, searchedNewActivityItems]
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
      ? visibleActionItems
      : groupMode === "repository"
        ? visibleRepositoryItems
        : groupMode === "pinned"
          ? searchedPinnedItems
          : groupMode === "snoozed"
            ? searchedSnoozedItems
            : searchedMutedItems
  const [selectedId, setSelectedId] = useState<string>(
    () =>
      (typeof window !== "undefined"
        ? loadStoredSelectedQueueItemId(window.sessionStorage)
        : "") ||
      visibleQueueItems[0]?.id ||
      activeItems[0]?.id ||
      ""
  )
  const selectedItem = resolveVisibleQueueItem(visibleQueueItems, selectedId)
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
    saveUserBucketLabels(window.localStorage, userBucketLabels)
  }, [userBucketLabels])

  useEffect(() => {
    saveStoredSelectedQueueItemId(window.sessionStorage, selectedId)
  }, [selectedId])

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
    if (!inboxView) return
    if (!visibleQueueItems.some((item) => item.id === selectedId)) {
      const storedSelectedId = loadStoredSelectedQueueItemId(window.sessionStorage)
      const storedVisibleItem = visibleQueueItems.find(
        (item) => item.id === storedSelectedId
      )
      setSelectedId(storedVisibleItem?.id ?? visibleQueueItems[0]?.id ?? "")
    }
  }, [inboxView, selectedId, visibleQueueItems])

  function moveSelectionAfterHiding(itemId: string) {
    const currentIndex = visibleQueueItems.findIndex((item) => item.id === itemId)
    const remainingVisible = visibleQueueItems.filter((item) => item.id !== itemId)
    const nextVisible =
      remainingVisible[Math.min(currentIndex, remainingVisible.length - 1)]
    const nextActive = searchedActiveItems.find((item) => item.id !== itemId)

    if (!nextVisible && isStashedGroupMode(groupMode)) {
      setGroupMode("action")
      setActiveActionTabId("home")
    }

    if (!nextVisible && groupMode === "action" && activeActionTabId !== "home") {
      setActiveActionTabId("home")
    }

    setSelectedId(nextVisible?.id ?? nextActive?.id ?? "")
  }

  async function markSelectedCaughtUp() {
    const itemToMark = selectedItem

    if (
      !itemToMark ||
      !canMarkReviewItemCaughtUp(itemToMark, markSeenMutation.isPending)
    ) {
      return
    }

    const itemId = itemToMark.id
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

  function updateBucketLabel(bucketId: UserBucketId, label: string) {
    const trimmedLabel = label.trim()
    setUserBucketLabels((current) => ({
      ...current,
      [bucketId]:
        trimmedLabel || defaultUserBuckets.find((bucket) => bucket.id === bucketId)?.label || bucketId,
    }))
  }

  function moveItemToBucket(itemId: string, bucketId: UserBucketId) {
    updateLocalItemState(itemId, (current) => ({
      ...current,
      bucketId,
    }))
  }

  function moveSelectedToBucket(bucketId: UserBucketId) {
    if (!selectedItem) return
    moveItemToBucket(selectedItem.id, bucketId)
    setActiveActionTabId(bucketId)
    setGroupMode("action")
  }

  function snoozeSelected() {
    if (!selectedItem || !canSnoozeLocalQueueItem(selectedItemLocalState)) return
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
    setActiveActionTabId(bucketIdForItem(selectedItem, localQueueState) ?? "home")
    setSelectedId(itemId)
  }

  function togglePinSelected() {
    if (!selectedItem || !canPinLocalQueueItem(selectedItemLocalState)) return
    const itemId = selectedItem.id
    const wasPinned = selectedItemIsPinned
    updateLocalItemState(itemId, (current) => ({
      ...current,
      pinned: current.pinned ? undefined : true,
    }))

    if (wasPinned && groupMode === "pinned") {
      setGroupMode("action")
      setActiveActionTabId(bucketIdForItem(selectedItem, localQueueState) ?? "home")
      setSelectedId(itemId)
    }
  }

  function muteSelected() {
    if (!selectedItem || !canMuteLocalQueueItem(selectedItemLocalState)) return
    const itemId = selectedItem.id
    updateLocalItemState(itemId, () => ({ muted: true }))
    moveSelectionAfterHiding(itemId)
  }

  function openSelectedDetail() {
    if (!selectedItem) return
    openItemDetail(selectedItem.id)
  }

  function openItemDetail(itemId: string) {
    void navigate({
      to: "/pull-requests/$pullRequestId",
      params: { pullRequestId: itemId },
    })
  }

  function openSelectedGitHub() {
    if (!selectedItem) return
    openExternalLink(selectedItem.url)
  }

  function focusHome() {
    setGroupMode("action")
    setActiveActionTabId("home")
    setSelectedId(searchedActiveItems[0]?.id ?? "")
  }

  function focusNewActivity() {
    if (searchedNewActivityItems.length === 0) return
    setGroupMode("action")
    setActiveActionTabId("new_activity")
    setSelectedId(searchedNewActivityItems[0]?.id ?? "")
  }

  function focusLane(laneId: LaneId) {
    setGroupMode("action")
    setActiveActionTabId(laneId)

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

  function applyGithubSearchQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextQuery = githubSearchQueryDraft.trim()
    setGithubSearchQueryDraft(nextQuery)
    setAppliedGithubSearchQuery(nextQuery || undefined)
    saveStoredGithubReviewQuery(nextQuery)
  }

  function resetGithubSearchQuery() {
    setGithubSearchQueryDraft("")
    setAppliedGithubSearchQuery(undefined)
    saveStoredGithubReviewQuery("")
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
    return <InboxLoadingScreen />
  }

  if (inboxQuery.isError || !inboxView) {
    return (
      <InboxStatusPanel
        title="Could not load review inbox"
        detail={
          inboxQuery.error instanceof Error
            ? inboxQuery.error.message
            : "The API is not reachable. Start the full app with the API server, then reload."
        }
      />
    )
  }

  return (
    <div
      className="grid min-h-[calc(100vh-48px)] overflow-x-auto"
      style={{
        gridTemplateColumns: `${REVIEW_SIDEBAR_WIDTH}px minmax(${REVIEW_WORKSPACE_MIN_WIDTH}px, 1fr)`,
      }}
    >
      <InboxSidebar
        laneItems={laneItems}
        userBucketLabels={userBucketLabels}
        activeActionTabId={groupMode === "action" ? activeActionTabId : undefined}
        newActivityCount={searchedNewActivityItems.length}
        pinnedActive={groupMode === "pinned"}
        pinnedCount={searchedPinnedItems.length}
        snoozedActive={groupMode === "snoozed"}
        snoozedCount={searchedSnoozedItems.length}
        mutedActive={groupMode === "muted"}
        mutedCount={searchedMutedItems.length}
        onSelectHome={focusHome}
        onSelectNewActivity={focusNewActivity}
        onSelectLane={focusLane}
        onSelectPinned={focusPinned}
        onSelectSnoozed={focusSnoozed}
        onSelectMuted={focusMuted}
        onBucketLabelChange={updateBucketLabel}
      />

      <section className="min-w-0 bg-background">
        <ResizablePanelGroup
          id="review-inbox-split"
          orientation="horizontal"
          defaultLayout={{ reviewQueue: 58, quickPeek: 42 }}
          resizeTargetMinimumSize={{ fine: 12, coarse: 36 }}
          className="h-full min-h-[calc(100vh-48px)]"
          style={{ minWidth: REVIEW_WORKSPACE_MIN_WIDTH }}
        >
          <ResizablePanel
            id="reviewQueue"
            defaultSize="58%"
            minSize={REVIEW_QUEUE_MIN_WIDTH}
            className="min-w-0"
          >
            <div className="flex h-full min-w-0 flex-col border-b border-border">
              <InboxHeader
                groupMode={groupMode}
                activeCount={searchedActiveItems.length}
                searchQuery={searchQuery}
                syncLabel={formatSyncLabel(inboxQuery.dataUpdatedAt)}
                githubSearchQuery={githubSearchQueryDraft}
                isGithubSearchPending={inboxQuery.isFetching}
                onGroupModeChange={setGroupMode}
                onGithubSearchQueryChange={setGithubSearchQueryDraft}
                onGithubSearchQueryReset={resetGithubSearchQuery}
                onGithubSearchQuerySubmit={applyGithubSearchQuery}
                onSearchQueryChange={setSearchQuery}
              />
              <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-7">
                {groupMode === "action" ? (
                  activeActionTabId === "home" ? (
                    lanes.map((lane) => (
                      <QueueLane
                        key={lane.id}
                        group={{
                          ...lane,
                          label: userBucketLabelFromId(userBucketLabels, lane.id),
                        }}
                        isOpen
                        items={laneItems[lane.id]}
                        selectedId={selectedItem?.id ?? ""}
                        userBucketLabels={userBucketLabels}
                        localQueueState={localQueueState}
                        onOpenDetail={openItemDetail}
                        onMoveItemToBucket={moveItemToBucket}
                        onToggle={() => undefined}
                        onSelect={setSelectedId}
                      />
                    ))
                  ) : (
                    <ActionQueueList
                      items={visibleActionItems}
                      selectedId={selectedItem?.id ?? ""}
                      userBucketLabels={userBucketLabels}
                      localQueueState={localQueueState}
                      onOpenDetail={openItemDetail}
                      onMoveItemToBucket={moveItemToBucket}
                      onSelect={setSelectedId}
                    />
                  )
                ) : groupMode === "repository" ? (
                  repositoryGroups.map((group) => (
                    <QueueLane
                      key={group.id}
                      group={group}
                      isOpen={openRepositoryIds.has(group.id)}
                      items={group.items}
                      selectedId={selectedItem?.id ?? ""}
                      userBucketLabels={userBucketLabels}
                      localQueueState={localQueueState}
                      onOpenDetail={openItemDetail}
                      onMoveItemToBucket={moveItemToBucket}
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
                    items={searchedPinnedItems}
                    selectedId={selectedItem?.id ?? ""}
                    userBucketLabels={userBucketLabels}
                    localQueueState={localQueueState}
                    onOpenDetail={openItemDetail}
                    onMoveItemToBucket={moveItemToBucket}
                    onToggle={() => undefined}
                    onSelect={setSelectedId}
                  />
                ) : groupMode === "snoozed" ? (
                  <QueueLane
                    group={{ id: "snoozed", label: "Snoozed", tone: "quiet" }}
                    isOpen
                    items={searchedSnoozedItems}
                    selectedId={selectedItem?.id ?? ""}
                    userBucketLabels={userBucketLabels}
                    localQueueState={localQueueState}
                    onOpenDetail={openItemDetail}
                    onMoveItemToBucket={moveItemToBucket}
                    onToggle={() => undefined}
                    onSelect={setSelectedId}
                  />
                ) : (
                  <QueueLane
                    group={{ id: "muted", label: "Muted", tone: "quiet" }}
                    isOpen
                    items={searchedMutedItems}
                    selectedId={selectedItem?.id ?? ""}
                    userBucketLabels={userBucketLabels}
                    localQueueState={localQueueState}
                    onOpenDetail={openItemDetail}
                    onMoveItemToBucket={moveItemToBucket}
                    onToggle={() => undefined}
                    onSelect={setSelectedId}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
          <ResizablePanelResizeHandle
            id="review-inbox-resize-handle"
            aria-label="Resize quick peek"
            className="group relative w-2 cursor-col-resize bg-background outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted data-[separator=active]:bg-muted"
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-foreground/30 group-focus-visible:bg-foreground/40" />
          </ResizablePanelResizeHandle>
          <ResizablePanel
            id="quickPeek"
            defaultSize="42%"
            minSize={QUICK_PEEK_MIN_WIDTH}
            className="min-w-0"
          >
            {selectedItem ? (
              <QuickPeekPanel
                item={selectedItem}
                bucketId={bucketIdForLocalQueueItem(
                  selectedItemLocalState,
                  selectedItem.laneId
                )}
                userBucketLabels={userBucketLabels}
                isPinned={selectedItemIsPinned}
                isSnoozed={selectedItemIsSnoozed}
                isMuted={selectedItemIsMuted}
                isMarkingSeen={markSeenMutation.isPending}
                caughtUpError={failedCaughtUpItemId === selectedItem.id}
                onSnooze={snoozeSelected}
                onRestore={restoreSelected}
                onTogglePin={togglePinSelected}
                onMute={muteSelected}
                onMoveToBucket={moveSelectedToBucket}
                onCaughtUp={() => void markSelectedCaughtUp()}
              />
            ) : (
              <EmptyPeekPanel groupMode={groupMode} searchQuery={searchQuery} />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </section>
    </div>
  )
}

function useInboxLoadingProgress(): {
  activeStepIndex: number
  elapsedSeconds: number
} {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    const startedAt = Date.now()
    const timer = globalThis.setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)

    return () => globalThis.clearInterval(timer)
  }, [])

  return {
    activeStepIndex: Math.min(
      inboxLoadingSteps.length - 1,
      Math.floor(elapsedMs / INBOX_LOADING_STEP_INTERVAL_MS)
    ),
    elapsedSeconds: Math.floor(elapsedMs / 1000),
  }
}

function InboxLoadingScreen() {
  const { activeStepIndex, elapsedSeconds } = useInboxLoadingProgress()
  const activeStep = inboxLoadingSteps[activeStepIndex] ?? inboxLoadingSteps[0]!
  const slowRequest = elapsedSeconds >= 8

  return (
    <div
      className="grid min-h-[calc(100vh-48px)] overflow-x-auto bg-background"
      style={{
        gridTemplateColumns: `${REVIEW_SIDEBAR_WIDTH}px minmax(${REVIEW_WORKSPACE_MIN_WIDTH}px, 1fr)`,
      }}
    >
      <LoadingSidebar />

      <section
        className="min-w-0 bg-background"
        style={{ minWidth: REVIEW_WORKSPACE_MIN_WIDTH }}
      >
        <div className="flex min-h-[calc(100vh-48px)] min-w-0">
          <div
            className="flex min-w-0 flex-col border-r border-border"
            style={{ width: `calc(58% - ${REVIEW_SPLIT_HANDLE_WIDTH / 2}px)` }}
          >
            <div className="flex h-[73px] items-center gap-4 border-b border-border px-5">
              <div className="min-w-0 flex-1">
                <div className="mb-2 h-4 w-40 rounded-sm bg-foreground/12" />
                <div className="h-3 w-64 rounded-sm bg-muted" />
              </div>
              <div className="h-8 w-52 rounded-md border border-border bg-muted/40" />
              <div className="h-8 w-36 rounded-md border border-border bg-muted/40" />
            </div>

            <div className="border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                {["Needs you", "Changed since", "Waiting", "Approved"].map(
                  (label, index) => (
                    <div
                      key={label}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs",
                        index === 0
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-border bg-muted/30 text-muted-foreground"
                      )}
                    >
                      {label}
                    </div>
                  )
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden pt-2">
              <LoadingQueueLane
                label="Needs your review"
                count="--"
                tone="hot"
                rows={3}
              />
              <LoadingQueueLane
                label="Changed since you last looked"
                count="--"
                tone="changed"
                rows={3}
              />
              <LoadingQueueLane
                label="Waiting on author"
                count="--"
                tone="waiting"
                rows={2}
              />
            </div>
          </div>

          <div className="w-2 bg-background">
            <div className="mx-auto h-full w-px bg-border" />
          </div>

          <div
            className="min-w-0 flex-1 bg-muted/20"
            style={{ minWidth: QUICK_PEEK_MIN_WIDTH }}
          >
            <div className="flex h-full min-h-[calc(100vh-48px)] flex-col">
              <div className="border-b border-border px-5 py-5" aria-live="polite">
                <div className="mb-4 flex items-center gap-3">
                  <div className="relative flex h-9 w-9 flex-none items-center justify-center rounded-full bg-foreground text-background">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    <span className="absolute inset-0 rounded-full ring-4 ring-foreground/10" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      {activeStep.progress}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Waiting {elapsedSeconds}s for the reviewer inbox response
                    </div>
                  </div>
                </div>
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  {activeStep.label}
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  {activeStep.detail}
                </p>
                <div className="mt-5 h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full w-1/3 animate-pulse rounded-full bg-foreground"
                  />
                </div>
              </div>

              <div className="grid gap-6 px-5 py-5">
                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      Request progress
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      local API · pending
                    </div>
                  </div>
                  <ol className="space-y-1">
                    {inboxLoadingSteps.map((step, index) => (
                      <LoadingStepRow
                        key={step.label}
                        step={step}
                        state={
                          index < activeStepIndex
                            ? "done"
                            : index === activeStepIndex
                              ? "active"
                              : "pending"
                        }
                      />
                    ))}
                  </ol>
                </div>

                <div className="border-l-2 border-border pl-4 text-sm leading-6 text-muted-foreground">
                  {slowRequest
                    ? "Still waiting on GitHub/API data. Larger repositories can spend most of the first load on per-PR reviews and changed-file metadata."
                    : "Keeping the main inbox request open while the API resolves source data and builds deterministic queue classifications."}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function LoadingSidebar() {
  return (
    <aside className="flex min-h-[calc(100vh-48px)] flex-col border-r border-border bg-sidebar px-3 py-4 text-sidebar-foreground">
      <div className="mb-4 flex items-center gap-2 px-2 py-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background">
          PR
        </div>
        <div className="h-3 w-24 rounded-sm bg-sidebar-foreground/20" />
      </div>
      <div className="space-y-5">
        <LoadingSidebarSection rows={5} />
        <LoadingSidebarSection rows={4} />
      </div>
      <div className="mt-auto hidden rounded-md border border-sidebar-border bg-sidebar-accent/45 p-3 sm:block">
        <div className="mb-2 h-2.5 w-28 rounded-sm bg-sidebar-foreground/15" />
        <div className="h-2.5 w-full rounded-sm bg-sidebar-foreground/10" />
      </div>
    </aside>
  )
}

function LoadingSidebarSection({ rows }: { rows: number }) {
  return (
    <div>
      <div className="mb-2 h-2.5 w-20 rounded-sm bg-sidebar-foreground/15 px-2" />
      <div className="space-y-1">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-2 rounded-md px-2 py-2"
          >
            <div className="h-2 w-2 rounded-full bg-sidebar-foreground/20" />
            <div className="h-2.5 flex-1 rounded-sm bg-sidebar-foreground/12" />
            <div className="h-2.5 w-5 rounded-sm bg-sidebar-foreground/10" />
          </div>
        ))}
      </div>
    </div>
  )
}

function LoadingQueueLane({
  label,
  count,
  tone,
  rows,
}: {
  label: string
  count: string
  tone: LaneDefinition["tone"]
  rows: number
}) {
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-3 px-5 py-3">
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        <span className={cn("h-2 w-2 rounded-full", laneToneClasses[tone])} />
        <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </div>
        <Badge variant="outline" className="ml-auto font-mono text-[11px]">
          {count}
        </Badge>
      </div>
      <div>
        {Array.from({ length: rows }, (_, index) => (
          <LoadingQueueRow key={index} tone={tone} />
        ))}
      </div>
    </section>
  )
}

function LoadingQueueRow({ tone }: { tone: LaneDefinition["tone"] }) {
  return (
    <div className="relative flex items-center gap-4 border-t border-border px-5 py-4">
      <span className={cn("absolute inset-y-0 left-0 w-0.5", laneToneClasses[tone])} />
      <div className="h-8 w-8 rounded-full border border-border bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3.5 w-3/5 rounded-sm bg-foreground/12" />
        <div className="flex gap-2">
          <div className="h-2.5 w-24 rounded-sm bg-muted" />
          <div className="h-2.5 w-14 rounded-sm bg-muted" />
          <div className="h-2.5 w-28 rounded-sm bg-muted" />
        </div>
      </div>
      <div className="hidden w-24 space-y-2 lg:block">
        <div className="ml-auto h-3 w-14 rounded-sm bg-foreground/10" />
        <div className="ml-auto h-2.5 w-20 rounded-sm bg-muted" />
      </div>
      <div className="hidden gap-1 xl:flex">
        <div className="h-7 w-7 rounded-md border border-border bg-muted/40" />
        <div className="h-7 w-7 rounded-md border border-border bg-muted/40" />
      </div>
    </div>
  )
}

function LoadingStepRow({
  step,
  state,
}: {
  step: InboxLoadingStep
  state: "done" | "active" | "pending"
}) {
  return (
    <li
      className={cn(
        "flex gap-3 rounded-md px-2 py-2.5 transition-colors",
        state === "active" && "bg-background",
        state === "done" && "text-foreground",
        state === "pending" && "text-muted-foreground"
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border",
          state === "done" && "border-emerald-200 bg-emerald-50 text-emerald-700",
          state === "active" && "border-foreground bg-foreground text-background",
          state === "pending" && "border-border bg-muted/30 text-muted-foreground"
        )}
      >
        {state === "done" ? (
          <Check className="h-3 w-3" />
        ) : state === "active" ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
        )}
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            "text-sm font-medium",
            state === "pending" ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {step.label}
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {step.detail}
        </div>
      </div>
    </li>
  )
}

function InboxSidebar({
  laneItems,
  userBucketLabels,
  activeActionTabId,
  newActivityCount,
  pinnedActive,
  pinnedCount,
  snoozedActive,
  snoozedCount,
  mutedActive,
  mutedCount,
  onSelectHome,
  onSelectNewActivity,
  onSelectLane,
  onSelectPinned,
  onSelectSnoozed,
  onSelectMuted,
  onBucketLabelChange,
}: {
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  userBucketLabels: UserBucketLabels
  activeActionTabId?: ActionQueueTabId
  newActivityCount: number
  pinnedActive: boolean
  pinnedCount: number
  snoozedActive: boolean
  snoozedCount: number
  mutedActive: boolean
  mutedCount: number
  onSelectHome: () => void
  onSelectNewActivity: () => void
  onSelectLane: (laneId: LaneId) => void
  onSelectPinned: () => void
  onSelectSnoozed: () => void
  onSelectMuted: () => void
  onBucketLabelChange: (bucketId: UserBucketId, label: string) => void
}) {
  const activeTotal = lanes.reduce(
    (total, lane) => total + laneItems[lane.id].length,
    0
  )

  return (
    <aside className="flex flex-col border-b border-border bg-card px-3 py-3 sm:border-r sm:border-b-0 sm:py-4">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2 sm:pb-4">
        <div className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-foreground text-[9px] font-bold text-background">
          R
        </div>
        <div className="text-xs text-foreground">
          Review Q
        </div>
      </div>
      <SidebarSection label="Views">
        <SidebarItem
          active={activeActionTabId === "home"}
          attention={activeTotal > 0}
          tone="quiet"
          label="All PRs"
          count={activeTotal}
          onClick={onSelectHome}
        />
        <SidebarItem
          active={activeActionTabId === "new_activity"}
          attention={newActivityCount > 0}
          tone="changed"
          label="New activity"
          count={newActivityCount}
          onClick={newActivityCount > 0 ? onSelectNewActivity : undefined}
        />
      </SidebarSection>
      <SidebarSection label="Buckets">
        {lanes.map((lane) => (
          <SidebarBucketItem
            key={lane.id}
            bucketId={lane.id}
            active={activeActionTabId === lane.id}
            attention={laneItems[lane.id].length > 0}
            tone={lane.tone}
            label={userBucketLabelFromId(userBucketLabels, lane.id)}
            count={laneItems[lane.id].length}
            onClick={
              laneItems[lane.id].length > 0
                ? () => onSelectLane(lane.id)
                : undefined
            }
            onLabelChange={onBucketLabelChange}
          />
        ))}
      </SidebarSection>
      <SidebarSection label="Stashed">
        <SidebarItem
          active={pinnedActive}
          attention={pinnedCount > 0}
          tone="changed"
          label="Pinned"
          count={pinnedCount}
          onClick={pinnedCount > 0 ? onSelectPinned : undefined}
        />
        <SidebarItem
          active={snoozedActive}
          attention={snoozedCount > 0}
          tone="waiting"
          label="Snoozed"
          count={snoozedCount}
          onClick={snoozedCount > 0 ? onSelectSnoozed : undefined}
        />
        <SidebarItem
          active={mutedActive}
          tone="quiet"
          label="Muted"
          count={mutedCount}
          onClick={mutedCount > 0 ? onSelectMuted : undefined}
        />
      </SidebarSection>
      <div className="mt-4 hidden rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground sm:mt-auto sm:block">
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
    <div className="grid min-h-[760px] place-items-center bg-background px-6">
      <div className="max-w-sm rounded-lg border border-border bg-card p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/40 text-foreground">
          <Inbox className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {detail ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
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
    <div className="mb-2 sm:mb-5">
      <div className="px-2 pb-2 pt-2 text-xs text-muted-foreground/70 sm:pt-3">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-1 sm:block sm:space-y-1">{children}</div>
    </div>
  )
}

function SidebarItem({
  label,
  count,
  active,
  attention,
  tone = "quiet",
  onClick,
}: {
  label: string
  count: number
  active?: boolean
  attention?: boolean
  tone?: LaneDefinition["tone"]
  onClick?: () => void
}) {
  const itemClassName = cn(
    "grid w-full grid-cols-[7px_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground sm:py-2 sm:text-sm",
    active && "bg-white text-foreground shadow-sm ring-1 ring-border",
    onClick && !active && "hover:bg-muted/40",
    !onClick && "cursor-default"
  )

  const content = (
    <>
      <span
        className={cn(
          "h-[7px] w-[7px] rounded-full bg-muted-foreground/30",
          attention && laneToneClasses[tone]
        )}
      />
      <span className={cn(attention && "font-medium text-foreground")}>{label}</span>
      <span
        className={cn(
          "text-xs text-muted-foreground/70",
          attention &&
            "rounded-full border px-2 py-[1px] font-semibold",
          attention && laneBadgeToneClasses[tone]
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

function SidebarBucketItem({
  bucketId,
  label,
  count,
  active,
  attention,
  tone,
  onClick,
  onLabelChange,
}: {
  bucketId: UserBucketId
  label: string
  count: number
  active?: boolean
  attention?: boolean
  tone: LaneDefinition["tone"]
  onClick?: () => void
  onLabelChange: (bucketId: UserBucketId, label: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftLabel, setDraftLabel] = useState(label)

  useEffect(() => {
    if (!editing) setDraftLabel(label)
  }, [editing, label])

  function saveDraftLabel() {
    setEditing(false)
    onLabelChange(bucketId, draftLabel)
  }

  if (editing) {
    return (
      <div className="grid grid-cols-[7px_1fr_auto] items-center gap-2 rounded-md bg-white px-2 py-1.5 shadow-sm ring-1 ring-border sm:py-2">
        <span className={cn("h-[7px] w-[7px] rounded-full", laneToneClasses[tone])} />
        <Input
          value={draftLabel}
          onChange={(event) => setDraftLabel(event.target.value)}
          onBlur={saveDraftLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveDraftLabel()
            if (event.key === "Escape") {
              setDraftLabel(label)
              setEditing(false)
            }
          }}
          autoFocus
          className="h-6 rounded-md px-2 text-xs"
        />
        <span className="text-xs text-muted-foreground/70">{count}</span>
      </div>
    )
  }

  return (
    <div className="group grid grid-cols-[1fr_24px] items-center gap-1">
      <SidebarItem
        active={active}
        attention={attention}
        tone={tone}
        label={label}
        count={count}
        onClick={onClick}
      />
      <button
        type="button"
        aria-label={`Rename ${label} bucket`}
        onClick={() => setEditing(true)}
        className="flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
      >
        <Edit3 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function InboxHeader({
  groupMode,
  activeCount,
  searchQuery,
  syncLabel,
  githubSearchQuery,
  isGithubSearchPending,
  onGroupModeChange,
  onGithubSearchQueryChange,
  onGithubSearchQueryReset,
  onGithubSearchQuerySubmit,
  onSearchQueryChange,
}: {
  groupMode: QueueGroupMode
  activeCount: number
  searchQuery: string
  syncLabel: string
  githubSearchQuery: string
  isGithubSearchPending: boolean
  onGroupModeChange: (mode: QueueGroupMode) => void
  onGithubSearchQueryChange: (query: string) => void
  onGithubSearchQueryReset: () => void
  onGithubSearchQuerySubmit: (event: FormEvent<HTMLFormElement>) => void
  onSearchQueryChange: (query: string) => void
}) {
  return (
    <div className="grid gap-3 border-b border-border bg-white px-5 py-4">
      <form
        className="flex min-w-0 items-center gap-2"
        onSubmit={onGithubSearchQuerySubmit}
      >
        <div className="relative min-w-0 flex-1">
          <Input
            id="github-review-query"
            type="search"
            value={githubSearchQuery}
            onChange={(event) => onGithubSearchQueryChange(event.target.value)}
            placeholder="is:open user-review-requested:@me"
            className="h-8 rounded-lg bg-background pr-3 pl-8 font-mono text-[13px]"
            aria-label="GitHub review search query"
          />
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={isGithubSearchPending}
          className="h-8"
        >
          Apply
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={githubSearchQuery.trim().length === 0 || isGithubSearchPending}
          onClick={onGithubSearchQueryReset}
          className="h-8 w-8"
          aria-label="Reset GitHub review query"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Review Inbox</h1>
            <span className="text-xs text-muted-foreground">· {syncLabel}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {activeCount} active PRs across user buckets
          </div>
        </div>
        <div className="relative min-w-0 flex-[1_1_100%] lg:ml-auto lg:min-w-[220px] lg:max-w-[360px] lg:flex-1">
          <Input
            id="review-inbox-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Filter loaded PRs"
            className="h-8 rounded-lg bg-background pr-3 pl-8 text-sm lg:pr-9"
          />
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Kbd className="absolute top-1/2 right-2 hidden -translate-y-1/2 lg:inline-flex">
            /
          </Kbd>
        </div>
        <Tabs
          value={groupMode}
          onValueChange={(value) => onGroupModeChange(value as QueueGroupMode)}
          className="gap-0"
        >
          <TabsList aria-label="Group pull requests">
            <TabsTrigger value="action" className="px-3">
              Buckets
            </TabsTrigger>
            <TabsTrigger value="repository" className="px-3">
              Repo
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-3 hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
          <Kbd>j</Kbd>
          <span>/</span>
          <Kbd>k</Kbd>
          <span>to move</span>
        </div>
      </div>
    </div>
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

function ActionQueueList({
  items,
  selectedId,
  userBucketLabels,
  localQueueState,
  onOpenDetail,
  onMoveItemToBucket,
  onSelect,
}: {
  items: ReviewQueueItemView[]
  selectedId: string
  userBucketLabels: UserBucketLabels
  localQueueState: LocalQueueStateByPullRequestId
  onOpenDetail: (id: string) => void
  onMoveItemToBucket: (itemId: string, bucketId: UserBucketId) => void
  onSelect: (id: string) => void
}) {
  return (
    <section>
      {items.length > 0 ? (
        <div>
          {items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              bucketId={bucketIdForLocalQueueItem(
                localQueueState[item.id],
                item.laneId
              )}
              userBucketLabels={userBucketLabels}
              onSelect={() => onSelect(item.id)}
              onOpenDetail={() => onOpenDetail(item.id)}
              onMoveToBucket={(bucketId) => onMoveItemToBucket(item.id, bucketId)}
            />
          ))}
        </div>
      ) : (
        <div className="border-b border-border px-5 py-10 text-sm text-muted-foreground">
          No PRs in this view.
        </div>
      )}
    </section>
  )
}

function QueueLane({
  group,
  isOpen,
  items,
  selectedId,
  userBucketLabels,
  localQueueState,
  onOpenDetail,
  onMoveItemToBucket,
  onToggle,
  onSelect,
}: {
  group: QueueGroupDefinition
  isOpen: boolean
  items: ReviewQueueItemView[]
  selectedId: string
  userBucketLabels: UserBucketLabels
  localQueueState: LocalQueueStateByPullRequestId
  onOpenDetail: (id: string) => void
  onMoveItemToBucket: (itemId: string, bucketId: UserBucketId) => void
  onToggle: () => void
  onSelect: (id: string) => void
}) {
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="grid w-full grid-cols-[4px_16px_1fr_auto] items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/25"
      >
        <span className={cn("h-5 w-1 rounded-full", laneToneClasses[group.tone])} />
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/70" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">
            {group.label}
          </span>
          {group.description ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {group.description}
            </span>
          ) : null}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-5 justify-self-end rounded-full px-2 text-xs",
            laneBadgeToneClasses[group.tone]
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
              bucketId={bucketIdForLocalQueueItem(
                localQueueState[item.id],
                item.laneId
              )}
              userBucketLabels={userBucketLabels}
              onSelect={() => onSelect(item.id)}
              onOpenDetail={() => onOpenDetail(item.id)}
              onMoveToBucket={(bucketId) => onMoveItemToBucket(item.id, bucketId)}
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
  bucketId,
  userBucketLabels,
  onSelect,
  onOpenDetail,
  onMoveToBucket,
}: {
  item: ReviewQueueItemView
  selected: boolean
  bucketId: UserBucketId
  userBucketLabels: UserBucketLabels
  onSelect: () => void
  onOpenDetail: () => void
  onMoveToBucket: (bucketId: UserBucketId) => void
}) {
  const tone = toneForItem(item)
  const reReviewRequested = item.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          onOpenDetail()
        }
      }}
      aria-pressed={selected}
      className={cn(
        "relative grid w-full cursor-pointer grid-cols-[26px_1fr_auto] items-center gap-3 border-t border-border px-5 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        selected && rowSelectedToneClasses[tone]
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          laneToneClasses[tone]
        )}
      />
      <AuthorAvatar
        login={item.authorLogin}
        avatarUrl={item.authorAvatarUrl}
        className="h-[26px] w-[26px]"
      />
      <span className="min-w-0">
        <span className="flex min-w-0 items-start gap-2 sm:items-center">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-foreground sm:truncate sm:line-clamp-1">
            {item.title}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full border border-border px-2 py-[1px] text-xs text-muted-foreground",
              item.waitingOn === "you" && laneBadgeToneClasses[tone]
            )}
          >
            {queuePillLabel(item)}
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="text-muted-foreground">
            {item.repository} / #{item.number}
          </span>
          <span className="text-muted-foreground/40">·</span>
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
          {reReviewRequested ? <FactChip icon={Eye} text="review requested" active /> : null}
        </span>
      </span>
      <span className="flex min-w-[74px] flex-col items-end gap-1">
        <BucketMoveMenu
          bucketId={bucketId}
          userBucketLabels={userBucketLabels}
          onMoveToBucket={onMoveToBucket}
          compact
        />
        <span
          className={cn(
            "text-xs text-muted-foreground",
            item.waitingOn === "you" && "font-semibold text-foreground"
          )}
        >
          {item.waitingAge}
        </span>
        <span className="text-xs text-muted-foreground/70">
          {queueTimingLabel(item)}
        </span>
      </span>
    </div>
  )
}

function BucketMoveMenu({
  bucketId,
  userBucketLabels,
  onMoveToBucket,
  compact,
}: {
  bucketId: UserBucketId
  userBucketLabels: UserBucketLabels
  onMoveToBucket: (bucketId: UserBucketId) => void
  compact?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={compact ? "xs" : "sm"}
          onClick={(event) => {
            event.stopPropagation()
          }}
          className={cn(
            "max-w-[150px] justify-start rounded-md px-2 text-xs",
            compact && "h-6 max-w-[112px]"
          )}
        >
          <ChevronsLeftRight className="h-3.5 w-3.5" />
          <span className="truncate">
            {userBucketLabelFromId(userBucketLabels, bucketId)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 rounded-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>Move to bucket</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {lanes.map((lane) => (
          <DropdownMenuItem
            key={lane.id}
            disabled={lane.id === bucketId}
            onClick={() => onMoveToBucket(lane.id)}
          >
            <span className={cn("h-2 w-2 rounded-full", laneToneClasses[lane.tone])} />
            {userBucketLabelFromId(userBucketLabels, lane.id)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
        "inline-flex items-center gap-1 rounded-[4px] border border-border bg-card px-1.5 py-[1px] text-xs text-muted-foreground",
        active && "border-foreground/50 bg-foreground/12 text-foreground"
      )}
    >
      <Icon className="h-3 w-3" />
      {text}
    </span>
  )
}

function AuthorAvatar({
  login,
  avatarUrl,
  className,
}: {
  login: string
  avatarUrl?: string
  className?: string
}) {
  const initials = login.slice(0, 2).toUpperCase()

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-white text-xs text-muted-foreground",
        className
      )}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={`${login} avatar`}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        initials
      )}
    </span>
  )
}

function QuickPeekPanel({
  item,
  bucketId,
  userBucketLabels,
  isPinned,
  isSnoozed,
  isMuted,
  isMarkingSeen,
  caughtUpError,
  onSnooze,
  onRestore,
  onTogglePin,
  onMute,
  onMoveToBucket,
  onCaughtUp,
}: {
  item: ReviewQueueItemView
  bucketId: UserBucketId
  userBucketLabels: UserBucketLabels
  isPinned: boolean
  isSnoozed: boolean
  isMuted: boolean
  isMarkingSeen: boolean
  caughtUpError: boolean
  onSnooze: () => void
  onRestore: () => void
  onTogglePin: () => void
  onMute: () => void
  onMoveToBucket: (bucketId: UserBucketId) => void
  onCaughtUp: () => void
}) {
  const canMarkCaughtUp = canMarkReviewItemCaughtUp(item, isMarkingSeen)
  const tone = toneForItem(item)
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
    <aside className="flex h-full min-h-[520px] min-w-0 flex-col bg-card">
      <div className="border-b border-border px-5 py-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <PanelRight className="h-3.5 w-3.5" />
          Quick peek · no need to open
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <BucketMoveMenu
            bucketId={bucketId}
            userBucketLabels={userBucketLabels}
            onMoveToBucket={onMoveToBucket}
          />
          {item.unseenEventCount > 0 ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2 text-xs font-medium text-sky-800">
              <Sparkles className="h-3.5 w-3.5" />
              {formatCount(item.unseenEventCount, "new event")}
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 text-xl font-semibold leading-7 tracking-tight text-foreground">
          {item.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {item.repository} / #{item.number}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{item.authorLogin}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className={cn(item.waitingOn === "you" && "text-foreground")}>
            {queueTimingLabel(item)} {item.waitingAge}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {item.description ? (
          <>
            <section>
              <div className="text-xs text-muted-foreground">
                PR description
              </div>
              <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
                <MarkdownContent source={item.description} compact />
              </div>
            </section>

            <Separator className="my-4 bg-border" />
          </>
        ) : null}

        <section className="rounded-md border border-border bg-card p-3.5">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" />
            <span className={cn("h-1.5 w-1.5 rounded-full", laneToneClasses[tone])} />
            Since your last visit · {item.lastSeenAt}
          </div>
          <ul className="mt-3 space-y-2 text-sm leading-5 text-foreground">
            {factRows.length > 0 ? factRows.map((row) => (
              <li key={row.id} className="flex gap-2">
                <span className={cn("mt-2 h-1.5 w-1.5 rounded-full", laneToneClasses[tone])} />
                <span>{row.label}</span>
              </li>
            )) : (
              <li className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                <span>No unseen activity since your last visit.</span>
              </li>
            )}
          </ul>
        </section>

        <Separator className="my-4 bg-border" />

        <section>
          <div className="text-xs text-muted-foreground">
            Open threads · {item.unresolvedThreadCount} of{" "}
            {item.totalThreadCount} unresolved
          </div>
          <div className="mt-3 space-y-2">
            {item.reviewThreads.length > 0 ? item.reviewThreads.map((thread) => (
              <div
                key={thread.id}
                className="grid grid-cols-[30px_1fr] gap-3 rounded-md border border-border bg-muted/30 p-3"
              >
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-border bg-muted/40 text-xs text-muted-foreground">
                  {thread.author.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="line-clamp-2 text-sm leading-5 text-foreground">
                    {thread.excerpt}
                  </div>
                  <div
                    className={cn(
                      "mt-1.5 text-xs",
                      thread.status === "unresolved"
                        ? "text-foreground"
                        : "text-muted-foreground/70"
                    )}
                  >
                    {thread.status}
                    {thread.authorReplied ? " · author replied" : ""}
                  </div>
                </div>
              </div>
            )) : (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm leading-5 text-muted-foreground">
                No open review threads.
              </div>
            )}
          </div>
        </section>

        <Separator className="my-4 bg-border" />

        <section>
          <div className="text-xs text-muted-foreground">
            Queue reason
          </div>
          <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-sm leading-5 text-foreground">
            {item.reason}
          </div>
        </section>

        {item.activityEvents.length > 0 ? (
          <>
            <Separator className="my-4 bg-border" />
            <section>
              <div className="text-xs text-muted-foreground">
                Latest activity
              </div>
              <div className="mt-3 space-y-2">
                {item.activityEvents.slice(0, 3).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md border border-border bg-muted/30 p-3 text-sm leading-5 text-foreground"
                  >
                    <div>
                      <ActivityEventLine event={event} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground/70">
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

      <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border px-5 py-4">
        {caughtUpError ? (
          <div className="col-span-2 rounded-md border border-foreground/30 bg-foreground/10 px-3 py-2 text-xs leading-5 text-foreground">
            Could not save caught-up state. Try again.
          </div>
        ) : null}
        <Button asChild className="col-span-2 h-9">
          <a href={item.url} {...externalLinkProps}>
            Open in GitHub to review
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={isSnoozed ? onRestore : onSnooze}
          disabled={isMuted}
          className="h-9 min-w-0 justify-center"
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
          className="h-9 min-w-0 justify-center"
        >
          <Pin className="h-4 w-4" />
          {isPinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={isMuted ? onRestore : onMute}
          disabled={isSnoozed}
          className="h-9 min-w-0 justify-center"
        >
          <BellOff className="h-4 w-4" />
          {isMuted ? "Unmute" : "Mute"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCaughtUp}
          disabled={!canMarkCaughtUp}
          className="h-9 min-w-0 justify-center"
        >
          <Check className="h-4 w-4" />
          {isMarkingSeen
            ? "Saving"
            : item.unseenEventCount === 0
              ? "All caught up"
              : "Mark caught up"}
        </Button>
        <Button
          asChild
          variant="ghost"
          className="col-span-2 h-9"
        >
          <Link to="/pull-requests/$pullRequestId" params={{ pullRequestId: item.id }}>
            <GitPullRequest className="h-4 w-4" />
            Open PR detail
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
  item: ReviewQueueItemView | undefined,
  localQueueState: LocalQueueStateByPullRequestId
): LaneId | undefined {
  if (!item) return undefined
  return bucketIdForLocalQueueItem(localQueueState[item.id], item.laneId)
}

function isStashedGroupMode(groupMode: QueueGroupMode): boolean {
  return groupMode === "pinned" || groupMode === "snoozed" || groupMode === "muted"
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

function toneForItem(item: ReviewQueueItemView): LaneDefinition["tone"] {
  if (item.laneId === "updated_since_review") return "changed"
  if (item.waitingOn === "you") return "hot"
  if (item.waitingOn === "author") return "waiting"
  if (item.laneId === "approved") return "success"
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

function EmptyPeekPanel({
  groupMode,
  searchQuery,
}: {
  groupMode: QueueGroupMode
  searchQuery: string
}) {
  const copy = getEmptyPeekCopy(groupMode, searchQuery)

  return (
    <aside className="flex h-full min-w-0 flex-col items-center justify-center bg-card px-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/30 text-foreground">
        <Check className="h-5 w-5" />
      </div>
      <h2 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
        {copy.title}
      </h2>
      <p className="mt-2 max-w-[300px] text-sm leading-6 text-muted-foreground">
        {copy.detail}
      </p>
    </aside>
  )
}
