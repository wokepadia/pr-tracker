import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
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
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { Link } from "@tanstack/react-router"
import {
  Group as ResizablePanelGroup,
  Panel as ResizablePanel,
  Separator as ResizablePanelResizeHandle,
} from "react-resizable-panels"
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsLeftRight,
  Clock3,
  Edit3,
  ExternalLink,
  Eye,
  BellOff,
  Maximize2,
  GitCommitHorizontal,
  GitPullRequest,
  GripVertical,
  Inbox,
  LoaderCircle,
  MessageSquareText,
  PanelRight,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActivityEventLine } from "@/components/ActivityEventLine"
import { AppLogo } from "@/components/AppLogo"
import { BoardItemNotes } from "@/components/BoardItemNotes"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { MarkdownContent } from "@/components/MarkdownContent"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  getBoardState,
  getReviewerInbox,
  markPullRequestSeen,
  saveBoardState,
} from "@/api"
import { formatCount } from "@/lib/copy"
import { cn, externalLinkProps } from "@/lib/utils"
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
  applyUserBucketItemOrder,
  createUserBucket,
  createEmptyUserBucketItemOrder,
  hasLocalQueueState,
  defaultUserBuckets,
  moveUserBucket,
  userBucketLabelFromId,
  type LocalPullRequestQueueState,
  type LocalQueueStateByPullRequestId,
  type UserBucketDefinition,
  type UserBucketId,
  type UserBucketItemOrder,
} from "@/reviewer/local-queue-state"
import {
  bucketDropId,
  filterQueueItems,
  moveItemInBucketItemOrder,
  resolveVisibleQueueItem,
  resolveKanbanDropTarget,
  type QueueGroupMode,
} from "./inbox-helpers"

type LaneId = UserBucketId
type ActionQueueTabId = "home" | "new_activity" | LaneId

const REVIEW_QUEUE_MIN_WIDTH = 680
const QUICK_PEEK_MIN_WIDTH = 320
const REVIEW_SPLIT_HANDLE_WIDTH = 8
const REVIEW_WORKSPACE_MIN_WIDTH =
  REVIEW_QUEUE_MIN_WIDTH + QUICK_PEEK_MIN_WIDTH + REVIEW_SPLIT_HANDLE_WIDTH
const REVIEW_SIDEBAR_WIDTH = 212
const INBOX_LOADING_STEP_INTERVAL_MS = 1050
const githubReviewQueryStorageKey = "pr-tracker:github-review-query:v1"
const DEFAULT_BUCKET_COLUMN_WIDTH = 232
const MIN_BUCKET_COLUMN_WIDTH = 200
const MAX_BUCKET_COLUMN_WIDTH = 420
const kanbanCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0
    ? pointerCollisions
    : rectIntersection(args)
}

function loadStoredGithubReviewQuery(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(githubReviewQueryStorageKey) ?? ""
}

function saveStoredGithubReviewQuery(query: string): void {
  window.localStorage.setItem(githubReviewQueryStorageKey, query)
}

function clampBucketColumnWidth(width: number): number {
  return Math.min(
    MAX_BUCKET_COLUMN_WIDTH,
    Math.max(MIN_BUCKET_COLUMN_WIDTH, Math.round(width))
  )
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

const defaultLaneDescriptions: Record<string, string> = {
  inbox: "Default place for active PRs",
  reviewing: "PRs you are actively reviewing",
  waiting: "Waiting for another person",
  later: "Keep visible, lower urgency",
  done: "Finished or caught up",
}

const defaultLaneTones: Record<string, LaneDefinition["tone"]> = {
  inbox: "hot",
  reviewing: "changed",
  waiting: "waiting",
  later: "quiet",
  done: "success",
}

const customLaneToneCycle: LaneDefinition["tone"][] = [
  "changed",
  "waiting",
  "quiet",
  "success",
  "hot",
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
    label: "Opening local inbox",
    detail: "Reading the desktop reviewer inbox from local SQLite.",
    progress: "Opening local reviewer data",
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
    label: "Preparing queue signals",
    detail: "Computing reviewer activity signals and default bucket placement.",
    progress: "Applying reviewer queue rules",
  },
  {
    label: "Preparing workspace",
    detail: "Arranging lanes, quick peek context, and the initial selection.",
    progress: "Rendering the review inbox",
  },
]

export function InboxPage() {
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
  const boardStateQuery = useQuery({
    queryKey: ["board-state"],
    queryFn: getBoardState,
  })
  const saveBoardStateMutation = useMutation({
    mutationFn: saveBoardState,
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
    useState<LocalQueueStateByPullRequestId>({})
  const [userBuckets, setUserBuckets] = useState<UserBucketDefinition[]>(() => {
    return defaultUserBuckets
  })
  const [userBucketItemOrder, setUserBucketItemOrder] =
    useState<UserBucketItemOrder>(() => {
      return createEmptyUserBucketItemOrder()
    })
  const [hasHydratedBoardState, setHasHydratedBoardState] = useState(false)
  const [failedCaughtUpItemId, setFailedCaughtUpItemId] = useState<string>()
  const [groupMode, setGroupMode] = useState<QueueGroupMode>("action")
  const [preferredGroupMode, setPreferredGroupMode] = useState<
    "action" | "repository"
  >("action")
  const [searchQuery, setSearchQuery] = useState("")
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null)
  const [bucketColumnWidths, setBucketColumnWidths] = useState<
    Record<UserBucketId, number>
  >({})
  const inboxView = useMemo(
    () => (inboxQuery.data ? buildInboxView(inboxQuery.data) : undefined),
    [inboxQuery.data]
  )
  const bucketLanes = useMemo(
    () => userBuckets.map((bucket, index) => bucketToLaneDefinition(bucket, index)),
    [userBuckets]
  )
  const availableBucketIds = useMemo(
    () => new Set(userBuckets.map((bucket) => bucket.id)),
    [userBuckets]
  )
  const fallbackBucketId = userBuckets[0]?.id ?? "inbox"
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
      bucketLanes.reduce(
        (acc, lane) => {
          acc[lane.id] = searchedActiveItems.filter(
            (item) =>
              bucketIdForAvailableUserBucket(
                item,
                localQueueState,
                availableBucketIds,
                fallbackBucketId
              ) ===
              lane.id
          )
          acc[lane.id] = applyUserBucketItemOrder(
            acc[lane.id] ?? [],
            lane.id,
            userBucketItemOrder
          )
          return acc
        },
        {} as Record<LaneId, ReviewQueueItemView[]>
      ),
    [
      availableBucketIds,
      bucketLanes,
      fallbackBucketId,
      localQueueState,
      searchedActiveItems,
      userBucketItemOrder,
    ]
  )
  const boardItems = useMemo(
    () => bucketLanes.flatMap((lane) => laneItems[lane.id] ?? []),
    [bucketLanes, laneItems]
  )
  const [activeActionTabId, setActiveActionTabId] =
    useState<ActionQueueTabId>("home")
  const visibleActionItems = useMemo(
    () =>
      activeActionTabId === "home"
        ? boardItems
        : activeActionTabId === "new_activity"
          ? searchedNewActivityItems
          : boardItems,
    [activeActionTabId, boardItems, searchedNewActivityItems]
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
  const [selectedId, setSelectedId] = useState<string>("")
  const selectedItem = resolveVisibleQueueItem(visibleQueueItems, selectedId)
  const selectedItemLocalState = selectedItem
    ? localQueueState[selectedItem.id] ?? {}
    : {}
  const selectedItemIsPinned = Boolean(selectedItemLocalState.pinned)
  const selectedItemIsSnoozed = Boolean(selectedItemLocalState.snoozed)
  const selectedItemIsMuted = Boolean(selectedItemLocalState.muted)
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )
  const draggingItem = draggingItemId
    ? activeItems.find((item) => item.id === draggingItemId)
    : undefined
  const draggingItemBucketId = draggingItem
    ? bucketIdForAvailableUserBucket(
        draggingItem,
        localQueueState,
        availableBucketIds,
        fallbackBucketId
      )
    : undefined

  useEffect(() => {
    if (!boardStateQuery.data) return

    setUserBuckets(boardStateQuery.data.buckets)
    setLocalQueueState(boardStateQuery.data.localQueueState)
    setUserBucketItemOrder(boardStateQuery.data.userBucketItemOrder)
    setBucketColumnWidths(boardStateQuery.data.bucketColumnWidths)
    setHasHydratedBoardState(true)
  }, [boardStateQuery.data])

  useEffect(() => {
    if (!hasHydratedBoardState) return

    saveBoardStateMutation.mutate({
      buckets: userBuckets,
      localQueueState,
      userBucketItemOrder,
      bucketColumnWidths,
    })
  }, [
    bucketColumnWidths,
    hasHydratedBoardState,
    localQueueState,
    userBucketItemOrder,
    userBuckets,
  ])

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
    if (selectedId && !visibleQueueItems.some((item) => item.id === selectedId)) {
      setSelectedId("")
    }
  }, [inboxView, selectedId, visibleQueueItems])

  function moveSelectionAfterHiding(itemId: string) {
    const remainingVisible = visibleQueueItems.filter((item) => item.id !== itemId)

    if (remainingVisible.length === 0 && isStashedGroupMode(groupMode)) {
      setGroupMode("action")
      setActiveActionTabId("home")
    }

    if (
      remainingVisible.length === 0 &&
      groupMode === "action" &&
      activeActionTabId !== "home"
    ) {
      setActiveActionTabId("home")
    }

    setSelectedId("")
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

  function saveUserBucketDefinitions(nextBuckets: UserBucketDefinition[]) {
    const sanitizedBuckets = nextBuckets.flatMap((bucket) => {
      const trimmedLabel = bucket.label.trim()
      return trimmedLabel ? [{ ...bucket, label: trimmedLabel }] : []
    })
    if (sanitizedBuckets.length === 0) return

    const nextBucketIds = new Set(sanitizedBuckets.map((bucket) => bucket.id))
    const removedBucketIds = userBuckets
      .map((bucket) => bucket.id)
      .filter((bucketId) => !nextBucketIds.has(bucketId))
    const fallbackBucket = sanitizedBuckets[0]!

    setUserBuckets(sanitizedBuckets)
    setLocalQueueState((current) => {
      if (removedBucketIds.length === 0) return current

      return Object.fromEntries(
        Object.entries(current).map(([itemId, itemState]) => {
          if (itemState?.bucketId && removedBucketIds.includes(itemState.bucketId)) {
            return [
              itemId,
              {
                ...itemState,
                bucketId: fallbackBucket.id,
              },
            ] as const
          }

          return [itemId, itemState] as const
        })
      )
    })
    setUserBucketItemOrder((current) => {
      const next = { ...current }
      const fallbackOrder = next[fallbackBucket.id] ?? []
      const fallbackOrderIds = new Set(fallbackOrder)

      for (const bucket of sanitizedBuckets) {
        next[bucket.id] = next[bucket.id] ?? []
      }

      for (const bucketId of removedBucketIds) {
        const movedItemIds = (next[bucketId] ?? []).filter(
          (itemId) => !fallbackOrderIds.has(itemId)
        )
        for (const itemId of movedItemIds) {
          fallbackOrderIds.add(itemId)
        }
        next[fallbackBucket.id] = [
          ...(next[fallbackBucket.id] ?? []),
          ...movedItemIds,
        ]
        delete next[bucketId]
      }

      return Object.fromEntries(
        sanitizedBuckets.map((bucket) => [bucket.id, next[bucket.id] ?? []])
      )
    })
    setBucketColumnWidths((current) => {
      return Object.fromEntries(
        sanitizedBuckets.flatMap((bucket) => {
          const width = current[bucket.id]
          return width ? [[bucket.id, width] as const] : []
        })
      )
    })

    if (
      typeof activeActionTabId === "string" &&
      removedBucketIds.includes(activeActionTabId)
    ) {
      setActiveActionTabId(fallbackBucket.id)
    }
  }

  function moveItemToBucket(
    itemId: string,
    bucketId: UserBucketId,
    overItemId?: string
  ) {
    const item = activeItems.find((candidate) => candidate.id === itemId)
    const currentBucketId = item
      ? bucketIdForAvailableUserBucket(
          item,
          localQueueState,
          availableBucketIds,
          fallbackBucketId
        )
      : bucketId

    updateLocalItemState(itemId, (current) => ({
      ...current,
      bucketId,
    }))
    setUserBucketItemOrder((current) =>
      moveItemInBucketItemOrder({
        current,
        itemId,
        sourceBucketId: currentBucketId,
        targetBucketId: bucketId,
        bucketItems: laneItems,
        overItemId,
      })
    )
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
    updateLocalItemState(itemId, (current) => ({
      ...current,
      muted: true,
    }))
    moveSelectionAfterHiding(itemId)
  }

  function updateSelectedNotes(notes: string) {
    if (!selectedItem) return
    updateLocalItemState(selectedItem.id, (current) => ({
      ...current,
      notes: notes.trim() ? notes : undefined,
    }))
  }

  function focusHome() {
    setGroupMode(preferredGroupMode)
    setActiveActionTabId("home")
    setSelectedId("")
  }

  function changeGroupMode(mode: QueueGroupMode) {
    setGroupMode(mode)
    if (mode === "action" || mode === "repository") {
      setPreferredGroupMode(mode)
    }
    if (mode === "action" && activeActionTabId === "new_activity") {
      setActiveActionTabId("home")
    }
  }

  function focusNewActivity() {
    if (searchedNewActivityItems.length === 0) return
    setGroupMode("action")
    setActiveActionTabId("new_activity")
    setSelectedId("")
  }

  function focusLane(laneId: LaneId) {
    setGroupMode("action")
    setActiveActionTabId(laneId)
    setSelectedId("")
  }

  function focusSnoozed() {
    if (searchedSnoozedItems.length === 0) return
    setGroupMode("snoozed")
    setSelectedId("")
  }

  function focusPinned() {
    if (searchedPinnedItems.length === 0) return
    setGroupMode("pinned")
    setSelectedId("")
  }

  function focusMuted() {
    if (searchedMutedItems.length === 0) return
    setGroupMode("muted")
    setSelectedId("")
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

  function handleKanbanDragStart(event: DragStartEvent) {
    const itemId = String(event.active.id)
    setDraggingItemId(itemId)
  }

  function handleKanbanDragEnd(event: DragEndEvent) {
    const itemId = String(event.active.id)
      const target = resolveKanbanDropTarget(
        event.over?.id,
      bucketLanes.map((lane) => lane.id),
      laneItems
    )

    setDraggingItemId(null)

    if (!target) return
    moveItemToBucket(itemId, target.bucketId, target.overItemId)
    setGroupMode("action")
    setActiveActionTabId("home")
  }

  if (inboxQuery.isLoading) {
    return <InboxLoadingScreen />
  }

  if (inboxQuery.isError || !inboxView) {
    return (
      <InboxStatusPanel
        title="Could not load review inbox"
        detail={
          inboxQuery.error
            ? formatUnknownError(inboxQuery.error)
            : "The desktop data layer could not load. Restart the app, then reload."
        }
        retryLabel={inboxQuery.isFetching ? "Retrying" : "Retry"}
        retryDisabled={inboxQuery.isFetching}
        onRetry={() => void inboxQuery.refetch()}
      />
    )
  }

  const reviewWorkspaceMinWidth = selectedItem
    ? REVIEW_WORKSPACE_MIN_WIDTH
    : REVIEW_QUEUE_MIN_WIDTH
  const headerView =
    groupMode === "pinned"
      ? {
          title: "Pinned",
          countLabel: formatCount(searchedPinnedItems.length, "pinned PR"),
        }
      : groupMode === "snoozed"
        ? {
            title: "Snoozed",
            countLabel: formatCount(searchedSnoozedItems.length, "snoozed PR"),
          }
        : groupMode === "muted"
          ? {
              title: "Muted",
              countLabel: formatCount(searchedMutedItems.length, "muted PR"),
            }
          : groupMode === "action" && activeActionTabId === "new_activity"
            ? {
                title: "New activity",
                countLabel: formatCount(
                  searchedNewActivityItems.length,
                  "PR with new activity",
                  "PRs with new activity"
                ),
              }
            : {
                title: "Review Inbox",
                countLabel: formatCount(searchedActiveItems.length, "active PR"),
              }
  const reviewQueuePanel = (
    <div className="flex h-full min-w-0 flex-col border-b border-border">
      <InboxHeader
        groupMode={groupMode}
        title={headerView.title}
        countLabel={headerView.countLabel}
        searchQuery={searchQuery}
        syncLabel={formatSyncLabel(inboxQuery.dataUpdatedAt)}
        githubSearchQuery={githubSearchQueryDraft}
        isGithubSearchPending={inboxQuery.isFetching}
        onGroupModeChange={changeGroupMode}
        onGithubSearchQueryChange={setGithubSearchQueryDraft}
        onGithubSearchQueryReset={resetGithubSearchQuery}
        onGithubSearchQuerySubmit={applyGithubSearchQuery}
        onSearchQueryChange={setSearchQuery}
      />
      <div
        className={cn(
          "min-h-0 flex-1",
          groupMode === "action" && activeActionTabId !== "new_activity"
            ? "overflow-hidden"
            : "overflow-y-auto pt-2 pb-7"
        )}
      >
        {groupMode === "action" ? (
          activeActionTabId !== "new_activity" ? (
            <KanbanBoard
              laneItems={laneItems}
              selectedId={selectedId}
              activeBucketId={
                activeActionTabId === "home" ? undefined : activeActionTabId
              }
              draggingItem={draggingItem}
              draggingItemBucketId={draggingItemBucketId}
              bucketLanes={bucketLanes}
              bucketColumnWidths={bucketColumnWidths}
              sensors={dragSensors}
              userBuckets={userBuckets}
              onDragStart={handleKanbanDragStart}
              onDragEnd={handleKanbanDragEnd}
              onDragCancel={() => setDraggingItemId(null)}
              onBucketColumnWidthChange={(bucketId, width) => {
                setBucketColumnWidths((current) => ({
                  ...current,
                  [bucketId]: clampBucketColumnWidth(width),
                }))
              }}
              onOpenPeek={setSelectedId}
            />
          ) : (
            <ActionQueueList
              items={visibleActionItems}
              selectedId={selectedId}
              bucketLanes={bucketLanes}
              userBuckets={userBuckets}
              fallbackBucketId={fallbackBucketId}
              localQueueState={localQueueState}
              onMoveItemToBucket={moveItemToBucket}
              onOpenPeek={setSelectedId}
            />
          )
        ) : groupMode === "repository" ? (
          repositoryGroups.map((group) => (
            <QueueLane
              key={group.id}
              group={group}
              isOpen={openRepositoryIds.has(group.id)}
              items={group.items}
              selectedId={selectedId}
              bucketLanes={bucketLanes}
              userBuckets={userBuckets}
              fallbackBucketId={fallbackBucketId}
              localQueueState={localQueueState}
              onMoveItemToBucket={moveItemToBucket}
              onToggle={() => {
                setOpenRepositoryIds((current) =>
                  toggleOpenGroup(current, group.id)
                )
              }}
              onOpenPeek={setSelectedId}
            />
          ))
        ) : groupMode === "pinned" ? (
          <QueueLane
            group={{ id: "pinned", label: "Pinned", tone: "changed" }}
            isOpen
            items={searchedPinnedItems}
            selectedId={selectedId}
            bucketLanes={bucketLanes}
            userBuckets={userBuckets}
            fallbackBucketId={fallbackBucketId}
            localQueueState={localQueueState}
            onMoveItemToBucket={moveItemToBucket}
            onToggle={() => undefined}
            onOpenPeek={setSelectedId}
          />
        ) : groupMode === "snoozed" ? (
          <QueueLane
            group={{ id: "snoozed", label: "Snoozed", tone: "quiet" }}
            isOpen
            items={searchedSnoozedItems}
            selectedId={selectedId}
            bucketLanes={bucketLanes}
            userBuckets={userBuckets}
            fallbackBucketId={fallbackBucketId}
            localQueueState={localQueueState}
            onMoveItemToBucket={moveItemToBucket}
            onToggle={() => undefined}
            onOpenPeek={setSelectedId}
          />
        ) : (
          <QueueLane
            group={{ id: "muted", label: "Muted", tone: "quiet" }}
            isOpen
            items={searchedMutedItems}
            selectedId={selectedId}
            bucketLanes={bucketLanes}
            userBuckets={userBuckets}
            fallbackBucketId={fallbackBucketId}
            localQueueState={localQueueState}
            onMoveItemToBucket={moveItemToBucket}
            onToggle={() => undefined}
            onOpenPeek={setSelectedId}
          />
        )}
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="grid h-full overflow-x-auto"
        style={{
          gridTemplateColumns: `${REVIEW_SIDEBAR_WIDTH}px minmax(${reviewWorkspaceMinWidth}px, 1fr)`,
          gridTemplateRows: "minmax(0, 1fr)",
        }}
      >
      <InboxSidebar
        laneItems={laneItems}
        bucketLanes={bucketLanes}
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
        userBuckets={userBuckets}
        onSaveBuckets={saveUserBucketDefinitions}
      />

      <section className="min-w-0 bg-background">
        {selectedItem ? (
          <ResizablePanelGroup
            id="review-inbox-split"
            orientation="horizontal"
            defaultLayout={{ reviewQueue: 68, quickPeek: 32 }}
            resizeTargetMinimumSize={{ fine: 12, coarse: 36 }}
            className="h-full"
            style={{ minWidth: REVIEW_WORKSPACE_MIN_WIDTH }}
          >
            <ResizablePanel
              id="reviewQueue"
              defaultSize="58%"
              minSize={REVIEW_QUEUE_MIN_WIDTH}
              className="min-w-0"
            >
              {reviewQueuePanel}
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
              <QuickPeekPanel
                item={selectedItem}
                bucketId={bucketIdForAvailableUserBucket(
                  selectedItem,
                  localQueueState,
                  availableBucketIds,
                  fallbackBucketId
                )}
                userBuckets={userBuckets}
                bucketLanes={bucketLanes}
                isPinned={selectedItemIsPinned}
                isSnoozed={selectedItemIsSnoozed}
                isMuted={selectedItemIsMuted}
                notes={selectedItemLocalState.notes ?? ""}
                isMarkingSeen={markSeenMutation.isPending}
                caughtUpError={failedCaughtUpItemId === selectedItem.id}
                onSnooze={snoozeSelected}
                onRestore={restoreSelected}
                onTogglePin={togglePinSelected}
                onMute={muteSelected}
                onNotesSave={updateSelectedNotes}
                onMoveToBucket={moveSelectedToBucket}
                onCaughtUp={() => void markSelectedCaughtUp()}
                onClose={() => setSelectedId("")}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div
            className="h-full"
            style={{ minWidth: REVIEW_QUEUE_MIN_WIDTH }}
          >
            {reviewQueuePanel}
          </div>
        )}
      </section>
      </div>
    </TooltipProvider>
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
    <div className="grid h-full place-items-center bg-muted/20 px-6 py-10">
      <section
        className="w-full max-w-[620px] overflow-hidden rounded-lg border border-border bg-card shadow-sm"
        aria-live="polite"
      >
        <div className="border-b border-border px-5 py-5">
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
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground" />
          </div>
        </div>

        <div className="grid gap-5 px-5 py-5">
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Request progress
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                local sync · pending
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
              ? "Still waiting on GitHub data. Larger repositories can spend most of the first load on per-PR reviews and activity metadata."
              : "Keeping the local inbox read open while the desktop app resolves source data and builds deterministic queue classifications."}
          </div>
        </div>
      </section>
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
  bucketLanes,
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
  userBuckets,
  onSaveBuckets,
}: {
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  bucketLanes: LaneDefinition[]
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
  userBuckets: UserBucketDefinition[]
  onSaveBuckets: (buckets: UserBucketDefinition[]) => void
}) {
  const [bucketDialogOpen, setBucketDialogOpen] = useState(false)
  const activeTotal = bucketLanes.reduce(
    (total, lane) => total + (laneItems[lane.id]?.length ?? 0),
    0
  )

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-b border-border bg-card px-3 py-3 sm:border-r sm:border-b-0 sm:py-4">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2 sm:pb-4">
        <AppLogo className="text-xs font-medium text-foreground" />
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
      <SidebarSection
        label="Buckets"
        action={
          <button
            type="button"
            aria-label="Manage buckets"
            onClick={() => setBucketDialogOpen(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </button>
        }
      >
        {bucketLanes.map((lane) => (
          <SidebarItem
            key={lane.id}
            active={activeActionTabId === lane.id}
            attention={(laneItems[lane.id]?.length ?? 0) > 0}
            tone={lane.tone}
            label={lane.label}
            count={laneItems[lane.id]?.length ?? 0}
            onClick={
              (laneItems[lane.id]?.length ?? 0) > 0
                ? () => onSelectLane(lane.id)
                : undefined
            }
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
      {bucketDialogOpen ? (
        <BucketManagerDialog
          buckets={userBuckets}
          bucketLanes={bucketLanes}
          laneItems={laneItems}
          onClose={() => setBucketDialogOpen(false)}
          onSave={(buckets) => {
            onSaveBuckets(buckets)
            setBucketDialogOpen(false)
          }}
        />
      ) : null}
    </aside>
  )
}

function InboxStatusPanel({
  title,
  detail,
  retryLabel,
  retryDisabled = false,
  onRetry,
}: {
  title: string
  detail?: string
  retryLabel?: string
  retryDisabled?: boolean
  onRetry?: () => void
}) {
  return (
    <div className="grid h-full place-items-center bg-background px-6">
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
        {onRetry ? (
          <Button
            className="mt-4 rounded-md"
            disabled={retryDisabled}
            type="button"
            variant="outline"
            onClick={onRetry}
          >
            <RotateCcw className={cn("h-4 w-4", retryDisabled && "animate-spin")} />
            {retryLabel ?? "Retry"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SidebarSection({
  label,
  children,
  action,
}: {
  label: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mb-2 sm:mb-5">
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-2 text-xs text-muted-foreground/70 sm:pt-3">
        <span>{label}</span>
        {action}
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

function BucketManagerDialog({
  buckets,
  bucketLanes,
  laneItems,
  onClose,
  onSave,
}: {
  buckets: UserBucketDefinition[]
  bucketLanes: LaneDefinition[]
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  onClose: () => void
  onSave: (buckets: UserBucketDefinition[]) => void
}) {
  const [draftBuckets, setDraftBuckets] = useState<UserBucketDefinition[]>(() =>
    buckets.map((bucket) => ({ ...bucket }))
  )
  const laneById = new Map(bucketLanes.map((lane) => [lane.id, lane]))
  const hasBlankLabel = draftBuckets.some(
    (bucket) => bucket.label.trim().length === 0
  )

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  function updateDraftBucketLabel(bucketId: UserBucketId, label: string) {
    setDraftBuckets((current) =>
      current.map((bucket) =>
        bucket.id === bucketId ? { ...bucket, label } : bucket
      )
    )
  }

  function addDraftBucket() {
    setDraftBuckets((current) => [
      ...current,
      createUserBucket("New label", current),
    ])
  }

  function deleteDraftBucket(bucketId: UserBucketId) {
    setDraftBuckets((current) => {
      if (current.length <= 1) return current
      return current.filter((bucket) => bucket.id !== bucketId)
    })
  }

  function moveDraftBucket(bucketId: UserBucketId, direction: "up" | "down") {
    setDraftBuckets((current) => moveUserBucket(current, bucketId, direction))
  }

  function saveDraftBuckets(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (hasBlankLabel) return

    onSave(
      draftBuckets.map((bucket) => ({
        ...bucket,
        label: bucket.label.trim(),
      }))
    )
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 px-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="bucket-manager-title"
        className="w-full max-w-[520px] rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={saveDraftBuckets}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2
              id="bucket-manager-title"
              className="text-base font-semibold text-foreground"
            >
              Manage buckets
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Rename, reorder, add, or delete the buckets shown in the left sidebar.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close bucket manager"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto px-5 py-4">
          <div className="space-y-2">
            {draftBuckets.map((bucket, index) => {
              const lane = laneById.get(bucket.id)
              const tone = lane?.tone ?? "quiet"
              const count = laneItems[bucket.id]?.length ?? 0
              return (
                <div
                  key={bucket.id}
                  className="grid grid-cols-[10px_56px_1fr_auto_32px] items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      laneToneClasses[tone]
                    )}
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Move ${bucket.label || "unnamed"} bucket up`}
                      disabled={index === 0}
                      onClick={() => moveDraftBucket(bucket.id, "up")}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${bucket.label || "unnamed"} bucket down`}
                      disabled={index === draftBuckets.length - 1}
                      onClick={() => moveDraftBucket(bucket.id, "down")}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                  <Input
                    value={bucket.label}
                    aria-label={`${bucket.label || "Unnamed"} bucket name`}
                    autoFocus={index === 0}
                    onChange={(event) =>
                      updateDraftBucketLabel(bucket.id, event.target.value)
                    }
                    className="h-8 rounded-md text-sm"
                  />
                  <span className="min-w-8 rounded-full border border-border px-2 py-1 text-center text-xs text-muted-foreground">
                    {count}
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete ${bucket.label || "unnamed"} bucket`}
                    disabled={draftBuckets.length <= 1}
                    onClick={() => deleteDraftBucket(bucket.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
          </div>
          {hasBlankLabel ? (
            <p className="mt-3 text-xs text-foreground">
              Bucket names cannot be blank.
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addDraftBucket}
          >
            <Plus className="h-4 w-4" />
            Add bucket
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={hasBlankLabel}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

function InboxHeader({
  groupMode,
  title,
  countLabel,
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
  title: string
  countLabel: string
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
  const [isQueryOpen, setIsQueryOpen] = useState(false)
  const hasCustomQuery = githubSearchQuery.trim().length > 0

  return (
    <div className="grid gap-3 border-b border-border bg-white px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <span className="text-xs text-muted-foreground">· {syncLabel}</span>
            <button
              type="button"
              aria-expanded={isQueryOpen}
              onClick={() => setIsQueryOpen((open) => !open)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isQueryOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Sync query
              {hasCustomQuery ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-sky-500"
                  title="A custom sync query is applied"
                />
              ) : null}
            </button>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{countLabel}</div>
        </div>
        <div className="relative min-w-0 flex-[1_1_100%] lg:ml-auto lg:min-w-[220px] lg:max-w-[360px] lg:flex-1">
          <Input
            id="review-inbox-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Filter loaded PRs"
            className="h-8 rounded-lg bg-background pr-3 pl-8 text-sm"
          />
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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
      </div>
      {isQueryOpen ? (
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
            disabled={
              githubSearchQuery.trim().length === 0 || isGithubSearchPending
            }
            onClick={onGithubSearchQueryReset}
            className="h-8 w-8"
            aria-label="Reset GitHub review query"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </form>
      ) : null}
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

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === "string" && error.trim()) {
    return error
  }

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== "{}") {
      return serialized
    }
  } catch {
    // Fall through to the generic message.
  }

  return "The desktop data layer could not load. Restart the app, then reload."
}

function bucketToLaneDefinition(
  bucket: UserBucketDefinition,
  index: number
): LaneDefinition {
  return {
    id: bucket.id,
    label: bucket.label,
    tone:
      defaultLaneTones[bucket.id] ??
      customLaneToneCycle[index % customLaneToneCycle.length] ??
      "quiet",
    description: defaultLaneDescriptions[bucket.id],
  }
}

function bucketIdForAvailableUserBucket(
  item: ReviewQueueItemView,
  localQueueState: LocalQueueStateByPullRequestId,
  availableBucketIds: Set<UserBucketId>,
  fallbackBucketId: UserBucketId
): UserBucketId {
  return bucketIdForAvailableBucketId(
    bucketIdForLocalQueueItem(localQueueState[item.id], item.laneId),
    [...availableBucketIds].map((id) => ({ id, label: id })),
    fallbackBucketId
  )
}

function bucketIdForAvailableBucketId(
  bucketId: UserBucketId,
  userBuckets: UserBucketDefinition[],
  fallbackBucketId: UserBucketId
): UserBucketId {
  return userBuckets.some((bucket) => bucket.id === bucketId)
    ? bucketId
    : fallbackBucketId
}

function KanbanBoard({
  laneItems,
  selectedId,
  activeBucketId,
  draggingItem,
  draggingItemBucketId,
  bucketLanes,
  bucketColumnWidths,
  sensors,
  userBuckets,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onBucketColumnWidthChange,
  onOpenPeek,
}: {
  laneItems: Record<LaneId, ReviewQueueItemView[]>
  selectedId: string
  activeBucketId?: LaneId
  draggingItem?: ReviewQueueItemView
  draggingItemBucketId?: UserBucketId
  bucketLanes: LaneDefinition[]
  bucketColumnWidths: Record<UserBucketId, number>
  sensors: ReturnType<typeof useSensors>
  userBuckets: UserBucketDefinition[]
  onDragStart: (event: DragStartEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
  onBucketColumnWidthChange: (bucketId: UserBucketId, width: number) => void
  onOpenPeek: (id: string) => void
}) {
  const columnWidths = bucketLanes.map(
    (lane) => bucketColumnWidths[lane.id] ?? DEFAULT_BUCKET_COLUMN_WIDTH
  )
  const boardMinWidth = columnWidths.reduce((total, width) => total + width, 0)

  function startColumnResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    bucketId: UserBucketId
  ) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = bucketColumnWidths[bucketId] ?? DEFAULT_BUCKET_COLUMN_WIDTH

    function handlePointerMove(moveEvent: PointerEvent) {
      onBucketColumnWidthChange(bucketId, startWidth + moveEvent.clientX - startX)
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp, { once: true })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <section className="flex h-full min-h-0 flex-col bg-muted/20">
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div
            className="flex h-full"
            style={{
              minWidth: `${boardMinWidth}px`,
            }}
          >
            {bucketLanes.map((lane, index) => (
              <div
                key={lane.id}
                className="relative h-full flex-none"
                style={{
                  width: `${columnWidths[index] ?? DEFAULT_BUCKET_COLUMN_WIDTH}px`,
                }}
              >
                <KanbanColumn
                  lane={lane}
                  active={activeBucketId === lane.id}
                  items={laneItems[lane.id] ?? []}
                  selectedId={selectedId}
                  bucketLanes={bucketLanes}
                  userBuckets={userBuckets}
                  onOpenPeek={onOpenPeek}
                />
                {index < bucketLanes.length - 1 ? (
                  <button
                    type="button"
                    aria-label={`Resize ${lane.label} column`}
                    onPointerDown={(event) => startColumnResize(event, lane.id)}
                    className="absolute top-0 right-[-4px] z-20 h-full w-2 cursor-col-resize bg-transparent outline-none transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10"
                  >
                    <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-border" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </section>
      <DragOverlay>
        {draggingItem ? (
          <div className="w-[252px] rotate-1 opacity-95 shadow-xl">
            <QueueCard
              item={draggingItem}
              selected
              bucketId={
                draggingItemBucketId ??
                bucketIdForLocalQueueItem(undefined, draggingItem.laneId)
              }
              bucketLanes={bucketLanes}
              userBuckets={userBuckets}
              dragging
              onOpenPeek={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function KanbanColumn({
  lane,
  active,
  items,
  selectedId,
  bucketLanes,
  userBuckets,
  onOpenPeek,
}: {
  lane: LaneDefinition
  active?: boolean
  items: ReviewQueueItemView[]
  selectedId: string
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  onOpenPeek: (id: string) => void
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: bucketDropId(lane.id),
  })

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex h-full min-h-0 flex-col border-r border-border bg-background/70 last:border-r-0",
        active && "bg-amber-50/35",
        isOver && "bg-sky-50/60"
      )}
    >
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", laneToneClasses[lane.tone])} />
              <h3 className="truncate text-xs font-semibold uppercase text-foreground">
                {lane.label}
              </h3>
            </div>
            {lane.description ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {lane.description}
              </p>
            ) : null}
          </div>
          <Badge
            variant="outline"
            className={cn(
              "h-6 rounded-full px-2 text-xs",
              laneBadgeToneClasses[lane.tone]
            )}
          >
            {items.length}
          </Badge>
        </div>
      </div>
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {items.length > 0 ? (
            items.map((item) => (
              <SortableQueueCard
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                bucketId={lane.id}
                bucketLanes={bucketLanes}
                userBuckets={userBuckets}
                onOpenPeek={() => onOpenPeek(item.id)}
              />
            ))
          ) : (
            <div className="grid min-h-[140px] place-items-center rounded-md border border-dashed border-border bg-card/50 px-4 text-center text-xs leading-5 text-muted-foreground">
              No PRs.
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  )
}

function SortableQueueCard({
  item,
  selected,
  bucketId,
  bucketLanes,
  userBuckets,
  onOpenPeek,
}: {
  item: ReviewQueueItemView
  selected: boolean
  bucketId: UserBucketId
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  onOpenPeek: () => void
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: item.id,
    data: {
      bucketId,
      type: "review-card",
    },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-30")}>
      <QueueCard
        item={item}
        selected={selected}
        bucketId={bucketId}
        bucketLanes={bucketLanes}
        userBuckets={userBuckets}
        dragHandle={
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Drag ${item.title}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        }
        onOpenPeek={onOpenPeek}
      />
    </div>
  )
}

function QueueCard({
  item,
  selected,
  bucketId,
  bucketLanes,
  userBuckets,
  dragHandle,
  dragging,
  onOpenPeek,
}: {
  item: ReviewQueueItemView
  selected: boolean
  bucketId: UserBucketId
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  dragHandle?: ReactNode
  dragging?: boolean
  onOpenPeek: () => void
}) {
  const tone = toneForItem(item)
  const reReviewRequested = item.activityEvents.some((event) =>
    event.isNew && event.action.toLowerCase().includes("requested your review")
  )

  return (
    <article
      data-selected={selected ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`Sneak peek ${item.title}`}
      onClick={onOpenPeek}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onOpenPeek()
      }}
      className={cn(
        "group relative cursor-pointer rounded-md border border-border bg-card p-3 text-left shadow-sm outline-none transition hover:border-foreground/20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-foreground/35 ring-2 ring-foreground/10",
        dragging && "cursor-grabbing"
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] rounded-l-md",
          laneToneClasses[tone]
        )}
      />
      <div className="flex items-center gap-2 pl-1">
        {dragHandle}
        <AuthorAvatar
          login={item.authorLogin}
          avatarUrl={item.authorAvatarUrl}
          className="h-6 w-6"
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{item.repository}</span>
            <span className="shrink-0 text-muted-foreground/40">#{item.number}</span>
          </span>
          {item.unseenEventCount > 0 ? (
            <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-[1px] font-medium text-sky-800">
              {formatCount(item.unseenEventCount, "new event")}
            </span>
          ) : null}
        </div>
      </div>
      <h4 className="mt-2 line-clamp-2 pl-1 text-sm font-semibold leading-5 text-foreground">
        {item.title}
      </h4>
      <div className="mt-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={queuePillTooltip(item)}
                className={cn(
                  "rounded-full border border-border px-2 py-[1px] text-xs text-muted-foreground",
                  item.waitingOn === "you" && laneBadgeToneClasses[tone]
                )}
              >
                {queuePillLabel(item)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{queuePillTooltip(item)}</TooltipContent>
          </Tooltip>
          {item.newCommitCount > 0 ? (
            <FactChip
              icon={GitCommitHorizontal}
              text={`+${item.newCommitCount}`}
              label={formatCount(item.newCommitCount, "new commit")}
              active
            />
          ) : null}
          {item.newReplyCount > 0 ? (
            <FactChip
              icon={MessageSquareText}
              text={`${item.newReplyCount}`}
              label={formatCount(item.newReplyCount, "new reply", "new replies")}
              active
            />
          ) : null}
          {item.totalThreadCount > 0 ? (
            <FactChip
              icon={Inbox}
              text={`${item.unresolvedThreadCount}/${item.totalThreadCount}`}
              label={`${item.unresolvedThreadCount} of ${formatCount(
                item.totalThreadCount,
                "review thread"
              )} unresolved`}
              active={item.unresolvedThreadCount > 0}
            />
          ) : null}
          {reReviewRequested ? (
            <FactChip
              icon={Eye}
              text="requested"
              label="Your review was requested again"
              active
            />
          ) : null}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{item.authorLogin}</span>
          </div>
          <span
            className={cn(
              "shrink-0 text-xs text-muted-foreground",
              item.waitingOn === "you" && "font-semibold text-foreground"
            )}
          >
            {item.waitingAge}
          </span>
        </div>
      </div>
    </article>
  )
}

function ActionQueueList({
  items,
  selectedId,
  bucketLanes,
  userBuckets,
  fallbackBucketId,
  localQueueState,
  onMoveItemToBucket,
  onOpenPeek,
}: {
  items: ReviewQueueItemView[]
  selectedId: string
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  fallbackBucketId: UserBucketId
  localQueueState: LocalQueueStateByPullRequestId
  onMoveItemToBucket: (itemId: string, bucketId: UserBucketId) => void
  onOpenPeek: (id: string) => void
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
              bucketLanes={bucketLanes}
              userBuckets={userBuckets}
              fallbackBucketId={fallbackBucketId}
              onOpenPeek={() => onOpenPeek(item.id)}
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
  bucketLanes,
  userBuckets,
  fallbackBucketId,
  localQueueState,
  onMoveItemToBucket,
  onToggle,
  onOpenPeek,
}: {
  group: QueueGroupDefinition
  isOpen: boolean
  items: ReviewQueueItemView[]
  selectedId: string
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  fallbackBucketId: UserBucketId
  localQueueState: LocalQueueStateByPullRequestId
  onMoveItemToBucket: (itemId: string, bucketId: UserBucketId) => void
  onToggle: () => void
  onOpenPeek: (id: string) => void
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
              bucketLanes={bucketLanes}
              userBuckets={userBuckets}
              fallbackBucketId={fallbackBucketId}
              onOpenPeek={() => onOpenPeek(item.id)}
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
  bucketLanes,
  userBuckets,
  fallbackBucketId,
  onOpenPeek,
  onMoveToBucket,
}: {
  item: ReviewQueueItemView
  selected: boolean
  bucketId: UserBucketId
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
  fallbackBucketId: UserBucketId
  onOpenPeek: () => void
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
      aria-label={`Sneak peek ${item.title}`}
      onClick={onOpenPeek}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onOpenPeek()
      }}
      className={cn(
        "relative grid w-full cursor-pointer grid-cols-[26px_1fr_auto] items-center gap-3 border-t border-border px-5 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
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
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={queuePillTooltip(item)}
                className={cn(
                  "shrink-0 rounded-full border border-border px-2 py-[1px] text-xs text-muted-foreground",
                  item.waitingOn === "you" && laneBadgeToneClasses[tone]
                )}
              >
                {queuePillLabel(item)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{queuePillTooltip(item)}</TooltipContent>
          </Tooltip>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="text-muted-foreground">
            {item.repository} / #{item.number}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{item.authorLogin}</span>
          {item.newCommitCount > 0 ? (
            <FactChip
              icon={GitCommitHorizontal}
              text={`+${item.newCommitCount}`}
              label={formatCount(item.newCommitCount, "new commit")}
              active
            />
          ) : null}
          {item.newReplyCount > 0 ? (
            <FactChip
              icon={MessageSquareText}
              text={`${item.newReplyCount}`}
              label={formatCount(item.newReplyCount, "new reply", "new replies")}
              active
            />
          ) : null}
          {item.totalThreadCount > 0 ? (
            <FactChip
              icon={Inbox}
              text={`${item.unresolvedThreadCount}/${item.totalThreadCount}`}
              label={`${item.unresolvedThreadCount} of ${formatCount(
                item.totalThreadCount,
                "review thread"
              )} unresolved`}
              active={item.unresolvedThreadCount > 0}
            />
          ) : null}
          {reReviewRequested ? (
            <FactChip
              icon={Eye}
              text="review requested"
              label="Your review was requested again"
              active
            />
          ) : null}
        </span>
      </span>
      <span className="flex min-w-[74px] flex-col items-end gap-1">
        <BucketMoveMenu
          bucketId={bucketIdForAvailableBucketId(bucketId, userBuckets, fallbackBucketId)}
          bucketLanes={bucketLanes}
          userBuckets={userBuckets}
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
  bucketLanes,
  userBuckets,
  onMoveToBucket,
  compact,
}: {
  bucketId: UserBucketId
  bucketLanes: LaneDefinition[]
  userBuckets: UserBucketDefinition[]
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
            {userBucketLabelFromId(userBuckets, bucketId)}
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
        {bucketLanes.map((lane) => (
          <DropdownMenuItem
            key={lane.id}
            disabled={lane.id === bucketId}
            onClick={() => onMoveToBucket(lane.id)}
          >
            <span className={cn("h-2 w-2 rounded-full", laneToneClasses[lane.tone])} />
            {lane.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FactChip({
  icon: Icon,
  text,
  label,
  active,
}: {
  icon: ComponentType<{ className?: string }>
  text: string
  label: string
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          className={cn(
            "inline-flex items-center gap-1 rounded-[4px] border border-border bg-card px-1.5 py-[1px] text-xs text-muted-foreground",
            active && "border-foreground/50 bg-foreground/12 text-foreground"
          )}
        >
          <Icon className="h-3 w-3" />
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
  userBuckets,
  bucketLanes,
  isPinned,
  isSnoozed,
  isMuted,
  notes,
  isMarkingSeen,
  caughtUpError,
  onSnooze,
  onRestore,
  onTogglePin,
  onMute,
  onNotesSave,
  onMoveToBucket,
  onCaughtUp,
  onClose,
}: {
  item: ReviewQueueItemView
  bucketId: UserBucketId
  userBuckets: UserBucketDefinition[]
  bucketLanes: LaneDefinition[]
  isPinned: boolean
  isSnoozed: boolean
  isMuted: boolean
  notes: string
  isMarkingSeen: boolean
  caughtUpError: boolean
  onSnooze: () => void
  onRestore: () => void
  onTogglePin: () => void
  onMute: () => void
  onNotesSave: (notes: string) => void
  onMoveToBucket: (bucketId: UserBucketId) => void
  onCaughtUp: () => void
  onClose: () => void
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
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PanelRight className="h-3.5 w-3.5" />
            {item.repository} / #{item.number}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant="ghost"
                  size="icon-sm"
                  className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                >
                  <Link
                    to="/pull-requests/$pullRequestId"
                    params={{ pullRequestId: item.id }}
                    aria-label={`Open full view for ${item.title}`}
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open full view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close sneak peek"
                  onClick={onClose}
                  className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close sneak peek</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <BucketMoveMenu
            bucketId={bucketId}
            bucketLanes={bucketLanes}
            userBuckets={userBuckets}
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
          <span>{item.authorLogin}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className={cn(item.waitingOn === "you" && "text-foreground")}>
            {queueTimingLabel(item)} {item.waitingAge}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <BoardItemNotes value={notes} onSave={onNotesSave} />

        <Separator className="my-4 bg-border" />

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

        {item.totalThreadCount > 0 ? (
          <>
            <Separator className="my-4 bg-border" />

            <section>
              <div className="text-xs text-muted-foreground">
                Open threads · {item.unresolvedThreadCount} of{" "}
                {item.totalThreadCount} unresolved
              </div>
              <div className="mt-3 space-y-2">
                {item.reviewThreads.map((thread) => (
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
                ))}
              </div>
            </section>
          </>
        ) : null}

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
          <div className="col-span-2 flex items-center justify-between gap-3 rounded-md border border-foreground/30 bg-foreground/10 px-3 py-2 text-xs leading-5 text-foreground">
            <span>Could not save caught-up state.</span>
            <Button
              className="h-7 rounded-md px-2 text-xs"
              disabled={isMarkingSeen}
              type="button"
              variant="outline"
              onClick={onCaughtUp}
            >
              <RotateCcw className={cn("h-3.5 w-3.5", isMarkingSeen && "animate-spin")} />
              Retry
            </Button>
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

function queuePillTooltip(item: ReviewQueueItemView): string {
  if (item.waitingOn === "you") return "Waiting on your review"
  if (item.waitingOn === "author") return "Waiting on the author"
  if (item.laneId === "approved") return "You approved this PR"
  if (item.laneId === "caught_up") return "You are caught up on this PR"
  if (item.laneId === "stale") return "No recent activity on this PR"
  return "You are watching this PR"
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
