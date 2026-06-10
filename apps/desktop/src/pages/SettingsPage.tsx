import {
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  KeyRound,
  Loader2,
} from "lucide-react"
import {
  createSqliteBackup,
  getGithubSettingsStatus,
} from "@/api"
import { GithubSettingsForm } from "@/components/GithubSettingsForm"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

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
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <KeyRound className="h-4 w-4" />
              Local GitHub access
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">
              GitHub token settings
            </h1>
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
            <div className="text-sm font-medium text-foreground">
              Token storage
            </div>
            <div className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {storageDescription}
            </div>
          </div>

          <Separator className="my-4" />

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

          <GithubSettingsForm settings={settingsQuery.data} />
        </Card>

        <Card className="rounded-md border-border p-5 shadow-none">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Database className="h-4 w-4" />
                SQLite backup
              </div>
              <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
                Unencrypted local database backup
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
