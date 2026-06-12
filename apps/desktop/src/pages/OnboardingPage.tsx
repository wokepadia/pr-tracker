import {
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeft,
  ArrowRight,
  Database,
  GitPullRequest,
  KeyRound,
  Layers,
  Loader2,
  RotateCcw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"
import {
  getGithubSettingsStatus,
  getOnboardingState,
  saveOnboardingState,
  type OnboardingState,
} from "@/api"
import { GithubSettingsForm } from "@/components/GithubSettingsForm"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

const onboardingVersion = 1

const slides = [
  {
    title: "A reviewer inbox for GitHub pull requests",
    body:
      "Review Ninja helps you decide which pull requests need your attention without opening every GitHub tab.",
    facts: [
      "Groups PRs by reviewer action state.",
      "Shows why each PR is in your queue.",
      "Sends you to GitHub when it is time to review code.",
    ],
    icon: Layers,
    preview: "inbox",
  },
  {
    title: "It reads review activity, not code intent",
    body:
      "The app syncs GitHub facts like review requests, submitted reviews, comments, commits, and thread state.",
    facts: [
      "No generated summaries in V1.",
      "No approving, commenting, or requesting changes from the app.",
      "Local state tracks what you have seen, pinned, muted, or snoozed.",
    ],
    icon: GitPullRequest,
    preview: "activity",
  },
  {
    title: "Your token stays out of the browser",
    body:
      "Use a read-only GitHub token scoped to the repositories you choose. The desktop app stores the saved token in a local Tauri Stronghold vault.",
    facts: [
      "Token is never returned to the browser after saving.",
      "Token is not stored in SQLite.",
      "The app only needs read access for the reviewer inbox.",
    ],
    icon: ShieldCheck,
    preview: "security",
  },
  {
    title: "Three details start the sync",
    body:
      "Enter a read-only token, the repositories to track, and your GitHub username. After saving, the app syncs selected PRs into the local cache.",
    facts: [
      "Token: fine-grained personal access token preferred.",
      "Repositories: comma-separated owner/repo names.",
      "Username: used to classify needs-my-review pull requests.",
    ],
    icon: KeyRound,
    preview: "setup",
  },
] as const

type OnboardingStep = "slides" | "setup"

export function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<OnboardingStep>("slides")
  const [slideIndex, setSlideIndex] = useState(0)
  const onboardingQuery = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: getOnboardingState,
  })
  const settingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const saveOnboardingMutation = useMutation({
    mutationFn: saveOnboardingState,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["onboarding-state"] })
    },
  })

  useEffect(() => {
    const state = onboardingQuery.data
    if (state?.introSkippedAt && !state.completedAt) {
      setStep("setup")
    }
  }, [onboardingQuery.data])

  async function skipIntro() {
    const introSkippedAt = new Date().toISOString()
    const current = onboardingQuery.data
    await saveOnboardingMutation.mutateAsync({
      version: onboardingVersion,
      introSkippedAt,
      completedAt: current?.completedAt,
    })
    setStep("setup")
  }

  async function completeOnboarding() {
    const current = onboardingQuery.data
    await saveOnboardingMutation.mutateAsync({
      version: onboardingVersion,
      introSkippedAt: current?.introSkippedAt,
      completedAt: new Date().toISOString(),
    })
    await navigate({ to: "/" })
  }

  const currentSlide = slides[slideIndex] ?? slides[0]!
  const Icon = currentSlide.icon
  const isFinalSlide = slideIndex === slides.length - 1

  if (step === "setup") {
    return (
      <OnboardingShell
        action={
          onboardingQuery.data?.completedAt ? (
            <Button asChild className="rounded-md" variant="outline">
              <Link to="/settings">Back to settings</Link>
            </Button>
          ) : null
        }
      >
        <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_320px] gap-5 px-6 py-8">
          <Card className="rounded-md border-border p-5 shadow-none">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-foreground text-background">
                <KeyRound className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-muted-foreground">
                  Local GitHub access
                </div>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">
                  Connect the repositories you review
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  The desktop app saves the token in a local Tauri Stronghold
                  vault and does not return it after saving. Repository settings
                  are stored in local app config.
                </p>
              </div>
            </div>

            <Separator className="my-5" />

            {settingsQuery.error ? (
              <OnboardingErrorNotice
                message={settingsQuery.error.message}
                retryDisabled={settingsQuery.isFetching}
                onRetry={() => void settingsQuery.refetch()}
              />
            ) : null}

            {onboardingQuery.error ? (
              <OnboardingErrorNotice
                message={onboardingQuery.error.message}
                retryDisabled={onboardingQuery.isFetching}
                onRetry={() => void onboardingQuery.refetch()}
              />
            ) : null}

            {saveOnboardingMutation.error ? (
              <OnboardingErrorNotice
                message={saveOnboardingMutation.error.message}
                retryDisabled={saveOnboardingMutation.isPending}
                onRetry={() => void completeOnboarding()}
              />
            ) : null}

            <GithubSettingsForm
              advancedInDisclosure
              settings={settingsQuery.data}
              submitLabel="Save and sync"
              successMessage="GitHub settings saved. Opening the reviewer inbox."
              secondaryAction={
                <Button
                  className="rounded-md"
                  disabled={saveOnboardingMutation.isPending}
                  type="button"
                  variant="outline"
                  onClick={() => void completeOnboarding()}
                >
                  {saveOnboardingMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Skip for now
                </Button>
              }
              onSaved={() => completeOnboarding()}
            />
          </Card>

          <SetupReferencePanel storage={settingsQuery.data?.storage} />
        </div>
      </OnboardingShell>
    )
  }

  return (
    <OnboardingShell
      action={
        <Button
          className="rounded-md"
          disabled={saveOnboardingMutation.isPending}
          variant="ghost"
          onClick={() => void skipIntro()}
        >
          Skip intro
        </Button>
      }
    >
      <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_340px] gap-5 px-6 py-8">
        <Card className="rounded-md border-border p-5 shadow-none">
          {onboardingQuery.error ? (
            <OnboardingErrorNotice
              message={onboardingQuery.error.message}
              retryDisabled={onboardingQuery.isFetching}
              onRetry={() => void onboardingQuery.refetch()}
            />
          ) : null}

          {saveOnboardingMutation.error ? (
            <OnboardingErrorNotice
              message={saveOnboardingMutation.error.message}
              retryDisabled={saveOnboardingMutation.isPending}
              onRetry={() => void skipIntro()}
            />
          ) : null}

          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Icon className="h-4 w-4" />
            Step {slideIndex + 1} of {slides.length}
          </div>
          <h1 className="mt-5 max-w-xl text-3xl font-semibold leading-tight tracking-normal">
            {currentSlide.title}
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
            {currentSlide.body}
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-sm text-foreground">
            {currentSlide.facts.map((fact) => (
              <li key={fact} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-foreground" />
                <span>{fact}</span>
              </li>
            ))}
          </ul>

          <div className="mt-8 flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5" aria-label="Slide progress">
              {slides.map((slide, index) => (
                <span
                  key={slide.title}
                  className={cn(
                    "h-2 w-2 rounded-full border border-border",
                    index === slideIndex && "border-foreground bg-foreground"
                  )}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Button
                className="rounded-md"
                disabled={slideIndex === 0}
                type="button"
                variant="outline"
                onClick={() => setSlideIndex((index) => Math.max(0, index - 1))}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                className="rounded-md"
                type="button"
                onClick={() => {
                  if (isFinalSlide) {
                    setStep("setup")
                    return
                  }
                  setSlideIndex((index) => Math.min(slides.length - 1, index + 1))
                }}
              >
                {isFinalSlide ? "Continue" : "Next"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>

        <SlidePreview type={currentSlide.preview} />
      </div>
    </OnboardingShell>
  )
}

function OnboardingErrorNotice({
  message,
  retryDisabled,
  onRetry,
}: {
  message: string
  retryDisabled: boolean
  onRetry: () => void
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <span>{message}</span>
      <Button
        className="h-8 rounded-md px-2 text-xs"
        disabled={retryDisabled}
        type="button"
        variant="outline"
        onClick={onRetry}
      >
        <RotateCcw className={cn("h-3.5 w-3.5", retryDisabled && "animate-spin")} />
        Retry
      </Button>
    </div>
  )
}

function OnboardingShell({
  action,
  children,
}: {
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-[calc(100vh-48px)] bg-background">
      <div className="flex h-12 items-center border-b border-border px-6">
        <div className="mr-auto text-sm font-medium text-foreground">
          First run setup
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function SlidePreview({
  type,
}: {
  type: (typeof slides)[number]["preview"]
}) {
  if (type === "security") {
    return (
      <Card className="rounded-md border-border p-5 shadow-none">
        <div className="text-sm font-medium">Local storage boundary</div>
        <div className="mt-5 flex flex-col gap-4 text-sm">
          <BoundaryRow icon={KeyRound} label="GitHub token" value="Tauri Stronghold" />
          <BoundaryRow icon={Layers} label="Repository list" value="Local app config" />
          <BoundaryRow icon={Database} label="PR cache and board state" value="Local SQLite cache" />
        </div>
      </Card>
    )
  }

  if (type === "activity") {
    return (
      <Card className="rounded-md border-border p-5 shadow-none">
        <div className="text-sm font-medium">Raw activity, newest first</div>
        <div className="mt-5 flex flex-col gap-3 text-sm">
          <PreviewLine label="author pushed 2 commits" meta="2h ago" />
          <PreviewLine label="you requested changes" meta="yesterday" />
          <PreviewLine label="thread resolved" meta="yesterday" />
        </div>
      </Card>
    )
  }

  if (type === "setup") {
    return (
      <Card className="rounded-md border-border p-5 shadow-none">
        <div className="text-sm font-medium">Setup checklist</div>
        <div className="mt-5 flex flex-col gap-3 text-sm">
          <PreviewLine label="Read-only GitHub token" meta="required" />
          <PreviewLine label="Repositories to track" meta="required" />
          <PreviewLine label="Your GitHub username" meta="recommended" />
        </div>
      </Card>
    )
  }

  return (
    <Card className="rounded-md border-border p-5 shadow-none">
      <div className="text-sm font-medium">Preview: reviewer inbox</div>
      <div className="mt-5 rounded-md border border-border bg-muted/40 p-3">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Needs your review
        </div>
        <div className="mt-3 rounded-md border border-border bg-background p-3 text-sm">
          <div className="text-xs text-muted-foreground">owner/repo #124</div>
          <div className="mt-1 font-medium">Normalize review request payloads</div>
          <div className="mt-2 text-xs text-muted-foreground">
            You are requested as a reviewer.
          </div>
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border p-3 text-sm">
        <div className="font-medium">Quick peek</div>
        <div className="mt-2 text-xs leading-5 text-muted-foreground">
          Why this needs attention
          <br />
          What changed recently
          <br />
          Open in GitHub
        </div>
      </div>
    </Card>
  )
}

function SetupReferencePanel({
  storage,
}: {
  storage?: "macos-keychain" | "stronghold"
}) {
  const storageLabel =
    storage === "macos-keychain" ? "macOS Keychain" : "Tauri Stronghold"

  return (
    <Card className="rounded-md border-border p-5 shadow-none">
      <div className="text-sm font-medium">Token guidance</div>
      <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
        <div>
          Use a fine-grained personal access token scoped to only the
          repositories you list.
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-3 text-foreground">
          Repository permissions: Pull requests read.
        </div>
        <div>Metadata read access is included by GitHub.</div>
        <div>Saved token storage: {storageLabel}.</div>
        <a
          className="text-sm font-medium text-foreground underline underline-offset-4"
          href="https://github.com/settings/personal-access-tokens"
          rel="noreferrer"
          target="_blank"
        >
          Open GitHub token settings
        </a>
      </div>
    </Card>
  )
}

function BoundaryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{value}</div>
    </div>
  )
}

function PreviewLine({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{meta}</span>
    </div>
  )
}
