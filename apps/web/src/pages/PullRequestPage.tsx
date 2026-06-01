import { useParams, Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export function PullRequestPage() {
  const { pullRequestId } = useParams({ from: "/pull-requests/$pullRequestId" })

  return (
    <div className="min-h-[760px] bg-[#242420] p-7">
      <div className="mb-6 flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">← Inbox</Link>
        </Button>
        <div>
          <div className="font-mono text-xs text-[#8e8b82]">
            selected PR · {pullRequestId}
          </div>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">
            PR detail foundation
          </h1>
        </div>
      </div>
      <Card className="border-white/10 bg-[#1e1e1b] p-6 text-[#dcd8ce]">
        <p className="max-w-2xl text-sm leading-6 text-[#bdb8ad]">
          The detail route is wired into the rebuilt shell. The Detail E
          activity timeline and deterministic context band land in the detail
          checkpoint.
        </p>
      </Card>
    </div>
  )
}
