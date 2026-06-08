import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { Settings } from "lucide-react"
import {
  getGithubSettingsStatus,
  getOnboardingState,
} from "@/api"
import { AppLogo } from "@/components/AppLogo"
import { shouldRedirectToOnboarding } from "./onboarding-gate"

export function AppFrame() {
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const onboardingQuery = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: getOnboardingState,
  })
  const settingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const onboardingComplete = Boolean(onboardingQuery.data?.completedAt)
  const tokenConfigured = Boolean(settingsQuery.data?.tokenConfigured)

  useEffect(() => {
    const shouldRedirect = shouldRedirectToOnboarding({
      pathname,
      onboardingComplete,
      tokenConfigured,
      isLoading: onboardingQuery.isLoading || settingsQuery.isLoading,
    })
    if (!shouldRedirect) return

    void navigate({ to: "/onboarding" })
  }, [
    navigate,
    onboardingComplete,
    onboardingQuery.isLoading,
    pathname,
    settingsQuery.isLoading,
    tokenConfigured,
  ])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed inset-x-0 top-0 z-20 flex h-[48px] items-center border-b border-border bg-white/95 px-5 text-xs text-muted-foreground backdrop-blur">
        <Link to="/" className="mr-auto inline-flex items-center gap-2 font-medium text-foreground">
          <AppLogo />
        </Link>
        <div className="ml-auto hidden text-right md:block">
          tracker, not a review surface · review happens in GitHub
        </div>
        <Link
          to="/settings"
          className="ml-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </Link>
      </header>

      <main className="pt-[48px]">
        <div className="min-h-[calc(100vh-48px)] bg-card">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
