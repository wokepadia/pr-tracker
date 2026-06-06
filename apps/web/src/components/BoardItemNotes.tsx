import { StickyNote } from "lucide-react"
import { cn } from "@/lib/utils"

export function BoardItemNotes({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <section className={cn("rounded-md border border-border bg-card p-3.5", className)}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <StickyNote className="h-3.5 w-3.5" />
        Notes
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Add private notes for this PR."
        rows={4}
        className="mt-3 min-h-[88px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/35 focus:ring-2 focus:ring-foreground/10"
      />
    </section>
  )
}
