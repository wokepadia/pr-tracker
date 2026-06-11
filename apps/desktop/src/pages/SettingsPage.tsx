import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  AlertTriangle,
  Check,
  Clock3,
  Database,
  Download,
  KeyRound,
  Loader2,
} from "lucide-react"
import {
  createSqliteBackup,
  getAttentionSettings,
  getGithubSettingsStatus,
  saveAttentionSettings,
} from "@/api"
import { AiSettingsCard } from "@/components/AiSettingsCard"
import { GithubSettingsForm } from "@/components/GithubSettingsForm"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export function SettingsPage() {
  const settingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const backupMutation = useMutation({
    mutationFn: createSqliteBackup,
  })

  const storageDescription =
    settingsQuery.data?.storage === "stronghold"
      ? "Saved tokens are stored in an encrypted local Tauri Stronghold vault, not in the browser or macOS Keychain."
      : "Saved tokens are stored in the desktop credential store, not in the browser."

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background px-6 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-foreground">
              Settings
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Everything is stored locally on this machine.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild className="rounded-md" variant="ghost">
              <Link to="/onboarding">View onboarding</Link>
            </Button>
            <Button asChild className="rounded-md" variant="outline">
              <Link to="/">Back to inbox</Link>
            </Button>
          </div>
        </div>

        <Card className="rounded-md border-border p-5 shadow-none">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="h-4 w-4" />
              GitHub connection
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
              Token and repositories
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {storageDescription}
            </p>
          </div>

          {settingsQuery.error ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span>{settingsQuery.error.message}</span>
              <Button
                className="h-8 rounded-md px-2 text-xs"
                disabled={settingsQuery.isFetching}
                type="button"
                variant="outline"
                onClick={() => void settingsQuery.refetch()}
              >
                {settingsQuery.isFetching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Retry
              </Button>
            </div>
          ) : null}

          {settingsQuery.isLoading ? (
            <div
              className="grid gap-3"
              aria-busy="true"
              aria-label="Loading saved settings"
            >
              <div className="h-9 animate-pulse rounded-md bg-muted/60" />
              <div className="h-9 animate-pulse rounded-md bg-muted/60" />
              <div className="h-9 w-40 animate-pulse rounded-md bg-muted/60" />
            </div>
          ) : (
            <GithubSettingsForm settings={settingsQuery.data} />
          )}
        </Card>

        <AttentionTimingCard />

        <AiSettingsCard />

        <Card className="rounded-md border-border p-5 shadow-none">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Database className="h-4 w-4" />
                Data &amp; backup
              </div>
              <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
                SQLite backup
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Create a plain SQLite backup of the local reviewer database.
                This does not include your GitHub token, which is stored
                separately from the reviewer database.
              </p>
            </div>
            <Button
              className="rounded-md"
              disabled={backupMutation.isPending}
              type="button"
              variant="outline"
              onClick={() => backupMutation.mutate()}
            >
              {backupMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Create backup
            </Button>
          </div>

          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                This SQLite backup is not encrypted. It can contain repository
                names, PR titles, comments, review activity, and your local
                queue state. You are responsible for storing it safely.
              </div>
            </div>
          </div>

          {backupMutation.error ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span>{backupMutation.error.message}</span>
              <Button
                className="h-8 rounded-md px-2 text-xs"
                disabled={backupMutation.isPending}
                type="button"
                variant="outline"
                onClick={() => backupMutation.mutate()}
              >
                {backupMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Retry
              </Button>
            </div>
          ) : null}

          {backupMutation.data ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-800">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                Created {backupMutation.data.filename}
                {backupMutation.data.path ? (
                  <>
                    <span className="text-emerald-700"> at </span>
                    <span className="break-all font-mono text-xs">
                      {backupMutation.data.path}
                    </span>
                  </>
                ) : (
                  "."
                )}
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  )
}

function AttentionTimingCard() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ["attention-settings"],
    queryFn: getAttentionSettings,
  })
  const [elevatedAfterHours, setElevatedAfterHours] = useState("")
  const [overdueAfterHours, setOverdueAfterHours] = useState("")
  const [hasBlurredInput, setHasBlurredInput] = useState(false)
  const [showSavedNotice, setShowSavedNotice] = useState(false)
  const saveMutation = useMutation({
    mutationFn: saveAttentionSettings,
    onSuccess: async (saved) => {
      setElevatedAfterHours(String(saved.elevatedAfterHours))
      setOverdueAfterHours(String(saved.overdueAfterHours))
      setHasBlurredInput(false)
      setShowSavedNotice(true)
      queryClient.setQueryData(["attention-settings"], saved)
      await queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] })
      await queryClient.invalidateQueries({ queryKey: ["pull-request"] })
    },
  })

  useEffect(() => {
    if (!settingsQuery.data) return
    setElevatedAfterHours(String(settingsQuery.data.elevatedAfterHours))
    setOverdueAfterHours(String(settingsQuery.data.overdueAfterHours))
  }, [settingsQuery.data])

  useEffect(() => {
    if (!showSavedNotice) return
    const timer = setTimeout(() => setShowSavedNotice(false), 2500)
    return () => clearTimeout(timer)
  }, [showSavedNotice])

  const parsedElevated = Number.parseInt(elevatedAfterHours, 10)
  const parsedOverdue = Number.parseInt(overdueAfterHours, 10)
  const isValid =
    Number.isFinite(parsedElevated) &&
    parsedElevated >= 1 &&
    Number.isFinite(parsedOverdue) &&
    parsedOverdue >= parsedElevated
  const isDirty =
    settingsQuery.data !== undefined &&
    (String(settingsQuery.data.elevatedAfterHours) !== elevatedAfterHours ||
      String(settingsQuery.data.overdueAfterHours) !== overdueAfterHours)

  return (
    <Card className="rounded-md border-border p-5 shadow-none">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Clock3 className="h-4 w-4" />
          Attention timing
        </div>
        <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
          Wait time highlighting
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          How long a pull request may sit on one party's turn before its wait
          time is highlighted in the queue: amber once a wait is elevated, red
          once it is overdue.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Elevated after (hours)
          <input
            className="h-9 w-40 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            inputMode="numeric"
            value={elevatedAfterHours}
            onBlur={() => setHasBlurredInput(true)}
            onChange={(event) => setElevatedAfterHours(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Overdue after (hours)
          <input
            className="h-9 w-40 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            inputMode="numeric"
            value={overdueAfterHours}
            onBlur={() => setHasBlurredInput(true)}
            onChange={(event) => setOverdueAfterHours(event.target.value)}
          />
        </label>
        <Button
          className="rounded-md"
          disabled={!isValid || !isDirty || saveMutation.isPending}
          type="button"
          onClick={() =>
            saveMutation.mutate({
              elevatedAfterHours: parsedElevated,
              overdueAfterHours: parsedOverdue,
            })
          }
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Save
        </Button>
        {showSavedNotice ? (
          <span
            className="inline-flex h-9 items-center gap-1 text-sm text-emerald-700"
            role="status"
          >
            <Check className="h-4 w-4" />
            Saved
          </span>
        ) : null}
      </div>

      {hasBlurredInput && !isValid ? (
        <div className="text-sm text-destructive">
          Use whole hours: elevated must be at least 1, and overdue must be
          greater than or equal to elevated.
        </div>
      ) : null}

      {saveMutation.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {saveMutation.error.message}
        </div>
      ) : null}
    </Card>
  )
}
