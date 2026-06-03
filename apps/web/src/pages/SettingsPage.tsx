import {
  useEffect,
  useState,
  type FormEvent,
} from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Check,
  KeyRound,
  Loader2,
} from "lucide-react"
import {
  getGithubSettingsStatus,
  saveGithubSettings,
} from "@/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

export function SettingsPage() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })
  const [token, setToken] = useState("")
  const [repositories, setRepositories] = useState("")
  const [viewerLogin, setViewerLogin] = useState("")
  const [apiBaseUrl, setApiBaseUrl] = useState("")
  const saveMutation = useMutation({
    mutationFn: saveGithubSettings,
    onSuccess: async (settings) => {
      setToken("")
      setRepositories(settings.repositories.join(", "))
      setViewerLogin(settings.viewerLogin ?? "")
      setApiBaseUrl(settings.apiBaseUrl ?? "")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["github-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["reviewer-inbox"] }),
      ])
    },
  })

  useEffect(() => {
    const settings = settingsQuery.data
    if (!settings) return

    setRepositories(settings.repositories.join(", "))
    setViewerLogin(settings.viewerLogin ?? "")
    setApiBaseUrl(settings.apiBaseUrl ?? "")
  }, [settingsQuery.data])

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    saveMutation.mutate({
      token: token || undefined,
      repositories,
      viewerLogin: viewerLogin || undefined,
      apiBaseUrl: apiBaseUrl || undefined,
    })
  }

  const tokenConfigured = settingsQuery.data?.tokenConfigured ?? false

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
          <Button asChild variant="outline">
            <Link to="/">Back to inbox</Link>
          </Button>
        </div>

        <Card className="rounded-md border-border p-5 shadow-none">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                Token storage
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Saved tokens are stored by the API in macOS Keychain, not in the browser.
              </div>
            </div>
            <Badge variant={tokenConfigured ? "default" : "secondary"}>
              {tokenConfigured ? "Token saved" : "Not configured"}
            </Badge>
          </div>

          <Separator className="my-5" />

          <form className="flex flex-col gap-4" onSubmit={submitSettings}>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">Read-only GitHub token</span>
              <Input
                autoComplete="off"
                placeholder={
                  tokenConfigured
                    ? "Leave blank to keep the saved token"
                    : "github_pat_..."
                }
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">Repositories</span>
              <Input
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
                placeholder="your-github-login"
                value={viewerLogin}
                onChange={(event) => setViewerLogin(event.target.value)}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">API base URL</span>
              <Input
                placeholder="https://api.github.com"
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
              />
            </label>

            {saveMutation.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {saveMutation.error.message}
              </div>
            ) : null}

            {saveMutation.isSuccess ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <Check className="h-4 w-4" />
                GitHub settings saved. The inbox will now use live GitHub data.
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                disabled={saveMutation.isPending}
                type="submit"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save settings
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  )
}
