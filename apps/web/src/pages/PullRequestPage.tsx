import { Link, useParams } from "@tanstack/react-router"
import type { ComponentType, ReactNode } from "react"
import {
  ArrowLeft,
  Check,
  Clock3,
  ExternalLink,
  GitCommitHorizontal,
  MessageSquareText,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type {
  ActivityEvent,
  ReviewDecision,
  ReviewQueueItem,
} from "@/data/review-data"
import { reviewItems } from "@/data/review-data"

const reviewDecisionLabels: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes req.",
  commented: "commented",
}

export function PullRequestPage() {
  const { pullRequestId } = useParams({ from: "/pull-requests/$pullRequestId" })
  const item = reviewItems.find((reviewItem) => reviewItem.id === pullRequestId)

  if (!item) {
    throw new Error(`Unknown pull request: ${pullRequestId}`)
  }

  const newEvents = item.activityEvents.filter((event) => event.isNew)
  const oldEvents = item.activityEvents.filter((event) => !event.isNew)
  const reReviewRequested = item.activityEvents.some((event) =>
    event.action.includes("re-requested your review")
  )

  return (
    <div className="min-h-[760px] bg-[#242420]">
      <DetailHeader item={item} />
      <ContextBand
        item={item}
        newEventCount={newEvents.length}
        reReviewRequested={reReviewRequested}
      />
      <div className="grid grid-cols-[62fr_38fr] gap-0 border-t border-white/10">
        <main className="min-w-0 px-7 py-6">
          <div className="mb-4 font-mono text-[10.5px] tracking-[0.12em] text-[#8e8b82] uppercase">
            Activity · newest first
          </div>
          <Timeline
            newEvents={newEvents}
            oldEvents={oldEvents}
            lastSeenAt={item.lastSeenAt}
          />
        </main>
        <DetailSideRail item={item} newEventCount={newEvents.length} />
      </div>
    </div>
  )
}

function DetailHeader({ item }: { item: ReviewQueueItem }) {
  return (
    <header className="grid grid-cols-[auto_1fr_auto] gap-5 border-b border-white/10 px-7 py-6">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mt-1 h-8 text-[#bdb8ad] hover:bg-white/[0.04] hover:text-[#f0ede4]"
      >
        <Link to="/">
          <ArrowLeft className="h-4 w-4" />
          Inbox
        </Link>
      </Button>

      <div className="min-w-0">
        <div className="font-mono text-[11px] text-[#8e8b82]">
          {item.repository} / #{item.number}
          <span className="mx-2 text-white/20">·</span>
          opened by {item.authorLogin}
          <span className="mx-2 text-white/20">·</span>
          {item.openedAt}
        </div>
        <h1 className="mt-2 text-[28px] font-semibold leading-9 tracking-tight text-[#f0ede4]">
          {item.title}
        </h1>
        <div className="mt-4 grid max-w-[760px] grid-cols-3 gap-2">
          <DetailFact
            label={item.waitingOn === "you" ? "Waiting on you" : "Waiting on author"}
            value={item.waitingAge}
            hot={item.waitingOn === "you"}
          />
          <DetailFact label="Your role" value="required reviewer" />
          <DetailFact
            label="Unseen events"
            value={`${item.unseenEventCount} since ${item.lastSeenAt}`}
            hot={item.unseenEventCount > 0}
          />
        </div>
      </div>

      <div className="flex min-w-[190px] flex-col items-stretch gap-3">
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-[#d8d3c8]">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#d0a24c]" />
          You requested changes
        </div>
        <Button
          asChild
          className="h-9 bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f]"
        >
          <a href={item.url} target="_blank" rel="noreferrer">
            Open in GitHub
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>
    </header>
  )
}

function DetailFact({
  label,
  value,
  hot,
}: {
  label: string
  value: string
  hot?: boolean
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="font-mono text-[9.5px] tracking-[0.1em] text-[#77736a] uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[12px] text-[#c9c5ba]",
          hot && "font-semibold text-[#d0a24c]"
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ContextBand({
  item,
  newEventCount,
  reReviewRequested,
}: {
  item: ReviewQueueItem
  newEventCount: number
  reReviewRequested: boolean
}) {
  return (
    <section className="px-7 py-5">
      <div className="rounded-lg border border-white/10 bg-[#1f1f1c] p-5">
        <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] text-[#8e8b82] uppercase">
          <RotateCcw className="h-3.5 w-3.5 text-[#d0a24c]" />
          Deterministic context since last visit
          <span className="text-white/20">·</span>
          {item.lastSeenAt}
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3">
          <ChangeCard
            icon={GitCommitHorizontal}
            value={`+${item.newCommitCount}`}
            label="new commits"
          />
          <ChangeCard
            icon={MessageSquareText}
            value={String(item.newReplyCount)}
            label="new replies"
          />
          <ChangeCard
            value={`${item.unresolvedThreadCount}/${item.totalThreadCount}`}
            label="threads open"
          />
          <ChangeCard
            value={reReviewRequested ? "yes" : "no"}
            label="re-review asked"
            hot={reReviewRequested}
          />
        </div>
        <div className="mt-4 grid gap-2 text-[13px] leading-5 text-[#d8d3c8]">
          {item.activityEvents
            .filter((event) => event.isNew)
            .slice(0, 3)
            .map((event) => (
              <div key={event.id} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#d0a24c]" />
                <span>
                  <b>{event.actor}</b> {event.action}
                  {event.detail ? ` - ${event.detail}` : ""}
                </span>
              </div>
            ))}
        </div>
        <div className="mt-4 font-mono text-[11px] text-[#8e8b82]">
          {newEventCount} new events, all shown in the timeline below.
        </div>
      </div>
    </section>
  )
}

function ChangeCard({
  icon: Icon,
  value,
  label,
  hot,
}: {
  icon?: ComponentType<{ className?: string }>
  value: string
  label: string
  hot?: boolean
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
      <div
        className={cn(
          "flex items-center gap-2 font-mono text-[22px] font-semibold text-[#f0ede4]",
          hot && "text-[#d0a24c]"
        )}
      >
        {Icon ? <Icon className="h-5 w-5" /> : null}
        {value}
      </div>
      <div className="mt-1 font-mono text-[10px] tracking-[0.1em] text-[#77736a] uppercase">
        {label}
      </div>
    </div>
  )
}

function Timeline({
  newEvents,
  oldEvents,
  lastSeenAt,
}: {
  newEvents: ActivityEvent[]
  oldEvents: ActivityEvent[]
  lastSeenAt: string
}) {
  return (
    <div className="relative">
      <div className="absolute top-2 bottom-2 left-[7px] w-px bg-white/10" />
      <div className="space-y-5">
        {newEvents.map((event) => (
          <TimelineItem key={event.id} event={event} isNew />
        ))}
        {newEvents.length > 0 && (
          <div className="relative flex items-center gap-3 py-1 pl-7">
            <span className="h-px flex-1 bg-white/10" />
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-[#d0a24c] uppercase">
              everything above is new since you last looked · {lastSeenAt}
            </span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
        )}
        {oldEvents.map((event) => (
          <TimelineItem key={event.id} event={event} />
        ))}
      </div>
    </div>
  )
}

function TimelineItem({
  event,
  isNew,
}: {
  event: ActivityEvent
  isNew?: boolean
}) {
  return (
    <div className="relative grid grid-cols-[112px_1fr] gap-5 pl-7">
      <span
        className={cn(
          "absolute top-1.5 left-0 h-3.5 w-3.5 rounded-full border border-white/20 bg-[#242420]",
          isNew && "border-[#d0a24c] bg-[#d0a24c]"
        )}
      />
      <div className="font-mono text-[11px] text-[#77736a]">{event.occurredAt}</div>
      <div>
        <div className="text-[13.5px] leading-5 text-[#ded9ce]">
          <b>{event.actor}</b> {event.action}
        </div>
        {event.detail ? (
          <div className="mt-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[12.5px] leading-5 text-[#bdb8ad]">
            {event.detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DetailSideRail({
  item,
  newEventCount,
}: {
  item: ReviewQueueItem
  newEventCount: number
}) {
  const totalAdditions = item.changedFilesSinceLastSeen.reduce(
    (total, file) => total + file.additions,
    0
  )
  const totalDeletions = item.changedFilesSinceLastSeen.reduce(
    (total, file) => total + file.deletions,
    0
  )

  return (
    <aside className="border-l border-white/10 bg-[#20201d] px-5 py-6">
      <RailCard title="Catch up">
        <div className="grid gap-2">
          <Button
            asChild
            className="h-9 justify-center bg-[#d0a24c] text-[#191916] hover:bg-[#e0b45f]"
          >
            <a href={item.url} target="_blank" rel="noreferrer">
              Review the {newEventCount} new events
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
          >
            <Check className="h-4 w-4" />
            Mark all caught up
          </Button>
        </div>
      </RailCard>

      <RailCard title="Where it stands">
        <RailKeyValue
          label="your review"
          value={reviewDecisionLabels[item.userLastReviewDecision]}
        />
        {item.otherReviewers.map((reviewer) => (
          <RailKeyValue
            key={reviewer.login}
            label={reviewer.login}
            value={
              reviewer.decision === "pending"
                ? "pending"
                : reviewDecisionLabels[reviewer.decision]
            }
          />
        ))}
        <RailKeyValue
          label="mergeable"
          value={item.waitingOn === "you" ? "blocked · you" : "waiting · author"}
        />
        <RailKeyValue label="size" value={`+${totalAdditions} / -${totalDeletions}`} />
      </RailCard>

      <RailCard title="Changed files">
        <div className="grid gap-1">
          {item.changedFilesSinceLastSeen.map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between gap-3 rounded-[4px] px-1 py-1 font-mono text-[11px] text-[#bdb8ad]"
            >
              <span className="truncate">{file.path}</span>
              <span className="text-[#8e8b82]">
                +{file.additions} / -{file.deletions}
              </span>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Stay on it">
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-center border-white/10 bg-transparent text-[#d8d3c8] hover:bg-white/[0.04] hover:text-[#f0ede4]"
        >
          <Clock3 className="h-4 w-4" />
          Snooze 1 day
        </Button>
      </RailCard>
    </aside>
  )
}

function RailCard({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 font-mono text-[10.5px] tracking-[0.12em] text-[#9f9a91] uppercase">
        {title}
      </div>
      {children}
    </section>
  )
}

function RailKeyValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2 font-mono text-[11px]">
        <span className="text-[#8e8b82]">{label}</span>
        <span className="text-[#d8d3c8]">{value}</span>
      </div>
      <Separator className="bg-white/10 last:hidden" />
    </>
  )
}
