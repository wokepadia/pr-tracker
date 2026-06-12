import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import {
  RotateCcw,
  Settings,
} from "lucide-react"
import {
  getAiSettings,
  getGithubSettingsStatus,
  getOnboardingState,
} from "@/api"
import { isAiModeActive } from "@/ai/ai-settings"
import { AppLogo } from "@/components/AppLogo"
import { Button } from "@/components/ui/button"
import { shouldRedirectToOnboarding } from "./onboarding-gate"
import { useGithubSyncController } from "./use-github-sync"
import { useReviewerInsights } from "./use-reviewer-insights"

export function AppFrame() {
  useGithubSyncController()
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
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  })
  // The AI Insights view exists only while AI mode is active; with it off
  // the app frame is unchanged.
  const aiActive = isAiModeActive(aiSettingsQuery.data)
  const { insights } = useReviewerInsights()
  const needsYouNowCount = insights?.needsYouNow.length ?? 0
  const gateError = onboardingQuery.error ?? settingsQuery.error
  const showGateError =
    Boolean(gateError) && pathname !== "/settings" && pathname !== "/onboarding"
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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="z-20 flex h-[48px] shrink-0 items-center border-b border-border bg-white px-5 text-xs text-muted-foreground">
        <Link to="/" className="inline-flex items-center gap-2 font-medium text-foreground">
          <AppLogo />
        </Link>
        <nav aria-label="Main views" className="ml-6 mr-auto flex items-center gap-1">
          <HeaderNavLink
            to="/"
            label="Inbox"
            active={pathname === "/" || pathname.startsWith("/pull-requests")}
          />
          <HeaderNavLink
            to="/insights"
            label="Insights"
            active={pathname.startsWith("/insights")}
            badgeCount={needsYouNowCount}
          />
          {aiActive ? (
            <HeaderNavLink
              to="/ai-insights"
              label="AI Insights"
              active={pathname.startsWith("/ai-insights")}
            />
          ) : null}
        </nav>
        <Link
          to="/settings"
          className="ml-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </Link>
      </header>

      <main className="min-h-0 flex-1">
        <div className="h-full overflow-y-auto bg-card">
          {showGateError ? (
            <div className="border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive">
              <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
                <span>
                  {gateError instanceof Error
                    ? gateError.message
                    : "Could not load local app state."}
                </span>
                <Button
                  className="h-8 rounded-md px-2 text-xs"
                  disabled={onboardingQuery.isFetching || settingsQuery.isFetching}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void onboardingQuery.refetch()
                    void settingsQuery.refetch()
                  }}
                >
                  <RotateCcw
                    className={
                      onboardingQuery.isFetching || settingsQuery.isFetching
                        ? "h-3.5 w-3.5 animate-spin"
                        : "h-3.5 w-3.5"
                    }
                  />
                  Retry
                </Button>
              </div>
            </div>
          ) : null}
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function HeaderNavLink({
  to,
  label,
  active,
  badgeCount = 0,
}: {
  to: string
  label: string
  active: boolean
  badgeCount?: number
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "inline-flex h-8 items-center rounded-md bg-muted px-3 text-xs font-semibold text-foreground"
          : "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }
    >
      {label}
      {badgeCount > 0 ? (
        <span
          aria-label={`${badgeCount} items need you now`}
          className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-[1px] text-[11px] font-semibold leading-4 text-amber-800"
        >
          {badgeCount}
        </span>
      ) : null}
    </Link>
  )
}
