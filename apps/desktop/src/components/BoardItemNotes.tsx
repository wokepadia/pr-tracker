import { useEffect, useState } from "react"
import { Edit3, Eye, Save, StickyNote, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MarkdownContent } from "./MarkdownContent"

export function BoardItemNotes({
  value,
  onSave,
  className,
}: {
  value: string
  onSave: (value: string) => void
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const [isEditing, setIsEditing] = useState(false)
  const hasNotes = value.trim().length > 0
  const hasDraft = draft.trim().length > 0
  const hasDraftChanges = draft !== value

  useEffect(() => {
    setDraft(value)
    setIsEditing(false)
  }, [value])

  function startEditing() {
    setDraft(value)
    setIsEditing(true)
  }

  function saveDraft() {
    onSave(draft.trim() ? draft : "")
    setIsEditing(false)
  }

  function discardDraft() {
    setDraft(value)
    setIsEditing(false)
  }

  return (
    <section className={cn("rounded-md border border-border bg-card p-3.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <StickyNote className="h-3.5 w-3.5" />
          Notes
        </div>
        {!isEditing ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={startEditing}
            aria-label={hasNotes ? "Edit notes" : "Add notes"}
            className="rounded-md text-muted-foreground hover:text-foreground"
          >
            <Edit3 className="h-3.5 w-3.5" />
            {hasNotes ? "Edit" : "Add"}
          </Button>
        ) : null}
      </div>

      {isEditing ? (
        <div className="mt-3 space-y-3">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add private notes for this PR."
            rows={5}
            className="min-h-[116px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/35 focus:ring-2 focus:ring-foreground/10"
          />
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              Preview
            </div>
            {hasDraft ? (
              <MarkdownContent source={draft} className="text-sm leading-5" />
            ) : (
              <p className="text-sm text-muted-foreground">No notes yet.</p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={discardDraft}
              className="rounded-md"
            >
              <X className="h-3.5 w-3.5" />
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={saveDraft}
              disabled={!hasDraftChanges}
              className="rounded-md"
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </div>
      ) : hasNotes ? (
        <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
          <MarkdownContent source={value} className="text-sm leading-5" />
        </div>
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="mt-3 flex min-h-[72px] w-full cursor-pointer items-center justify-center rounded-md border border-dashed border-border bg-muted/20 px-3 text-sm text-muted-foreground outline-none transition-colors hover:border-foreground/25 hover:bg-muted/35 hover:text-foreground focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-foreground/10"
        >
          Add note
        </button>
      )}
    </section>
  )
}
