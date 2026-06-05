import { ExternalLink } from "lucide-react"
import { externalLinkProps } from "@/lib/utils"
import type { ActivityEventView } from "@/reviewer/view-model"

export function ActivityEventLine({ event }: { event: ActivityEventView }) {
  return (
    <>
      <b>{event.actor}</b>{" "}
      {event.url ? (
        <a
          href={event.url}
          className="font-medium underline underline-offset-2 hover:text-muted-foreground"
          {...externalLinkProps}
        >
          {event.action}
        </a>
      ) : (
        event.action
      )}
      {event.diffUrl ? (
        <>
          {" "}
          <a
            href={event.diffUrl}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            {...externalLinkProps}
          >
            Diff
            <ExternalLink className="h-3 w-3" />
          </a>
        </>
      ) : null}
    </>
  )
}
