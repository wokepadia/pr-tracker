import { Link, Outlet } from "@tanstack/react-router"

export function AppFrame() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed inset-x-0 top-0 z-20 flex h-[46px] items-center border-b border-border bg-background/95 px-5 text-xs text-muted-foreground backdrop-blur">
        <Link to="/" className="mr-auto font-medium text-foreground">
          Review Queue
        </Link>
        <div className="ml-auto hidden text-right md:block">
          tracker, not a review surface · review happens in GitHub
        </div>
      </header>

      <main className="px-5 pt-[68px] pb-7">
        <div className="mx-auto min-h-[760px] max-w-[1156px] overflow-hidden rounded-[10px] border border-border bg-card shadow-2xl shadow-black/5">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
