import { Link, Outlet } from "@tanstack/react-router"

export function AppFrame() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed inset-x-0 top-0 z-20 flex h-[48px] items-center border-b border-border bg-white/95 px-5 text-xs text-muted-foreground backdrop-blur">
        <Link to="/" className="mr-auto inline-flex items-center gap-2 font-medium text-foreground">
          <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-foreground text-[9px] font-bold text-background">
            R
          </span>
          Review Queue
        </Link>
        <div className="ml-auto hidden text-right md:block">
          tracker, not a review surface · review happens in GitHub
        </div>
      </header>

      <main className="pt-[48px]">
        <div className="min-h-[calc(100vh-48px)] bg-card">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
