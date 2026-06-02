import { Link, Outlet } from "@tanstack/react-router"

export function AppFrame() {
  return (
    <div className="min-h-screen bg-[#272724] text-[#ebe9e3]">
      <header className="fixed inset-x-0 top-0 z-20 flex h-[46px] items-center border-b border-white/8 bg-[#22221f]/95 px-5 text-[11px] tracking-[0.18em] text-[#9b9991] uppercase backdrop-blur">
        <Link to="/" className="mr-auto font-medium text-[#d8d6cf]">
          Review Queue
        </Link>
        <div className="ml-auto hidden text-right tracking-[0.12em] md:block">
          tracker, not a review surface · review happens in GitHub
        </div>
      </header>

      <main className="px-5 pt-[68px] pb-7">
        <div className="mx-auto min-h-[760px] max-w-[1156px] overflow-hidden rounded-[10px] border border-white/10 bg-[#1f1f1f] shadow-2xl shadow-black/30">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
