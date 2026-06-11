import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import {
  Check,
  Loader2,
} from "lucide-react"
import {
  saveGithubSettings,
  type GithubSettingsStatus,
} from "@/api"
import { useGithubSync } from "@/app/use-github-sync"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface GithubSettingsFormProps {
  settings?: GithubSettingsStatus
  submitLabel?: string
  successMessage?: string
  secondaryAction?: ReactNode
  advancedInDisclosure?: boolean
  onSaved?: (settings: GithubSettingsStatus) => void | Promise<void>
}

export function GithubSettingsForm({
  settings,
  submitLabel = "Save settings",
  successMessage = "GitHub settings saved. The inbox will now use live GitHub data.",
  secondaryAction,
  advancedInDisclosure = false,
  onSaved,
}: GithubSettingsFormProps) {
  const queryClient = useQueryClient()
  const { syncNow } = useGithubSync()
  const [token, setToken] = useState("")
  const [repositories, setRepositories] = useState("")
  const [viewerLogin, setViewerLogin] = useState("")
  const [apiBaseUrl, setApiBaseUrl] = useState("")
  const saveMutation = useMutation({
    mutationFn: saveGithubSettings,
    onSuccess: async (savedSettings) => {
      setToken("")
      setRepositories(savedSettings.repositories.join(", "))
      setViewerLogin(savedSettings.viewerLogin ?? "")
      setApiBaseUrl(savedSettings.apiBaseUrl ?? "")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["github-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
      ])
      // New settings should take effect immediately, not on the next
      // scheduled background sync.
      syncNow()
      await onSaved?.(savedSettings)
    },
  })

  useEffect(() => {
    if (!settings) return

    setRepositories(settings.repositories.join(", "))
    setViewerLogin(settings.viewerLogin ?? "")
    setApiBaseUrl(settings.apiBaseUrl ?? "")
  }, [settings])

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    retrySaveSettings()
  }

  function retrySaveSettings() {
    saveMutation.mutate({
      token: token || undefined,
      repositories,
      viewerLogin: viewerLogin || undefined,
      apiBaseUrl: apiBaseUrl || undefined,
    })
  }

  const tokenConfigured = settings?.tokenConfigured ?? false
  const fieldInputClassName = "rounded-md border-border bg-background"
  const apiBaseUrlField = (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium">API base URL</span>
      <Input
        className={fieldInputClassName}
        placeholder="https://api.github.com"
        value={apiBaseUrl}
        onChange={(event) => setApiBaseUrl(event.target.value)}
      />
    </label>
  )

  return (
    <form className="flex flex-col gap-4" onSubmit={submitSettings}>
      <label className="flex flex-col gap-2">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Read-only GitHub token</span>
          {settings ? (
            <Badge variant={tokenConfigured ? "default" : "secondary"}>
              {tokenConfigured ? "Token saved" : "Not configured"}
            </Badge>
          ) : null}
        </span>
        <Input
          autoComplete="off"
          className={fieldInputClassName}
          placeholder={
            tokenConfigured
              ? "Leave blank to keep the saved token"
              : "github_pat_..."
          }
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="text-xs leading-5 text-muted-foreground">
          Recommended: fine-grained personal access token, selected repositories,
          Pull requests read. Metadata read access is included by GitHub.
        </span>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Repositories</span>
        <Input
          className={fieldInputClassName}
          placeholder="zulip/zulip"
          value={repositories}
          onChange={(event) => setRepositories(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Use comma-separated owner/repo names.
        </span>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Your GitHub username</span>
        <Input
          className={fieldInputClassName}
          placeholder="your-github-login"
          value={viewerLogin}
          onChange={(event) => setViewerLogin(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Used to classify pull requests that need your review.
        </span>
      </label>

      {advancedInDisclosure ? (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced
          </summary>
          <div className="mt-3">{apiBaseUrlField}</div>
        </details>
      ) : (
        apiBaseUrlField
      )}

      {saveMutation.error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{saveMutation.error.message}</span>
          <Button
            className="h-8 rounded-md px-2 text-xs"
            disabled={saveMutation.isPending}
            type="button"
            variant="outline"
            onClick={retrySaveSettings}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Retry
          </Button>
        </div>
      ) : null}

      {saveMutation.isSuccess ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <Check className="h-4 w-4" />
          {successMessage}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-2">
        <div>{secondaryAction}</div>
        <Button
          className="rounded-md"
          disabled={saveMutation.isPending}
          type="submit"
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
