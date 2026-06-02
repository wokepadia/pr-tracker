import { Link, Outlet } from "@tanstack/react-router"

export function AppFrame() {
  return (
    <div className="min-h-screen bg-[#f6f7f8] text-foreground">
      <header className="fixed inset-x-0 top-0 z-20 flex h-[48px] items-center border-b border-border bg-white/95 px-5 text-xs text-muted-foreground backdrop-blur">
        <Link to="/" className="mr-auto inline-flex items-center gap-2 font-medium text-foreground">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgb(245_158_11_/_0.16)]" />
          Review Queue
        </Link>
        <div className="ml-auto hidden text-right md:block">
          tracker, not a review surface · review happens in GitHub
        </div>
      </header>

      <main className="px-4 pt-[70px] pb-7 sm:px-5">
        <div className="mx-auto min-h-[760px] max-w-[1240px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgb(15_23_42_/_0.08)]">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
