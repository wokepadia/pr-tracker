import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { reviewItems } from "@/data/review-data"

export function InboxPage() {
  return (
    <div className="grid min-h-[760px] grid-cols-[212px_1fr]">
      <aside className="border-r border-white/10 bg-[#191916] px-3 py-5">
        <div className="px-8 py-1 text-xs font-semibold tracking-wide text-[#ddd9ce]">
          Review Q
        </div>
        <Separator className="my-5 bg-white/10" />
        <div className="space-y-2 text-sm text-[#a5a299]">
          <div className="rounded-md bg-white/[0.06] px-4 py-2 text-[#f0ede4]">
            Needs you <span className="float-right text-[#d0a24c]">7</span>
          </div>
          <div className="px-4 py-2">
            Changed since <span className="float-right">4</span>
          </div>
          <div className="px-4 py-2">
            Waiting on author <span className="float-right">12</span>
          </div>
          <div className="px-4 py-2">
            Approved · recent <span className="float-right">9</span>
          </div>
        </div>
      </aside>

      <section className="bg-[#242420]">
        <div className="flex h-[62px] items-center border-b border-white/10 px-5">
          <h1 className="text-lg font-medium tracking-tight">Review Inbox</h1>
          <span className="ml-4 text-xs text-[#8e8b82]">· synced 2m ago</span>
          <Badge variant="outline" className="ml-auto border-white/10 text-[#c9c5ba]">
            group: action
          </Badge>
        </div>
        <div className="grid min-h-[697px] grid-cols-[58fr_42fr]">
          <div className="border-r border-white/10 p-5">
            <Card className="border-white/10 bg-[#1e1e1b] p-5 text-[#dcd8ce]">
              <div className="text-xs tracking-[0.16em] text-[#8e8b82] uppercase">
                Foundation checkpoint
              </div>
              <p className="mt-3 max-w-xl text-sm leading-6 text-[#bdb8ad]">
                The Rhea shell, shadcn primitives, routing, and deterministic mock
                review data are in place. The next checkpoint replaces this panel
                with the exact Inbox C lanes and quick peek behavior.
              </p>
              <div className="mt-5 grid gap-2">
                {reviewItems.slice(0, 3).map((item) => (
                  <div
                    key={item.id}
                    className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-xs text-[#9e9a90]">
                      {item.repository} / #{item.number}
                    </span>
                    <div className="mt-1 truncate text-[#ede9df]">{item.title}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="p-5">
            <Card className="flex h-full flex-col border-white/10 bg-[#20201d] p-5 text-[#dcd8ce]">
              <div className="text-xs tracking-[0.16em] text-[#8e8b82] uppercase">
                Quick peek slot
              </div>
              <p className="mt-3 text-sm leading-6 text-[#bdb8ad]">
                This stays fixed on the right side of the inbox and will show
                deterministic catch-up facts for the selected PR.
              </p>
            </Card>
          </div>
        </div>
      </section>
    </div>
  )
}
