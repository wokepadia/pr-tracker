import { useEffect } from "react"
import { PullRequestDetailSurface } from "@/pages/PullRequestPage"

/**
 * Opens the pull request detail surface as a modal over the current view.
 * The home dashboard expands a card into this overlay; closing it returns to
 * the dashboard with its scroll and state intact.
 */
export function PullRequestDetailModal({
  pullRequestId,
  onClose,
}: {
  pullRequestId: string
  onClose: () => void
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 px-8 py-8 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Pull request details"
        className="min-h-[calc(100vh-4rem)] w-full max-w-[1180px] overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PullRequestDetailSurface
          pullRequestId={pullRequestId}
          onRequestClose={onClose}
        />
      </section>
    </div>
  )
}
