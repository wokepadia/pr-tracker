import type { ReviewQueueItemView } from "@/reviewer/view-model"

export function detailAttentionLabel(
  item: Pick<ReviewQueueItemView, "waitingOn" | "laneId">
): string {
  if (item.waitingOn === "you") return "waiting on you"
  if (item.waitingOn === "author") return "waiting on author"
  if (item.laneId === "approved") return "approved"
  if (item.laneId === "caught_up") return "caught up"
  if (item.laneId === "stale") return "stale"
  return "watching"
}
