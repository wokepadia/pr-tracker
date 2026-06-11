import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useState, type FormEvent } from "react"
import {
  Check,
  Loader2,
  Sparkles,
} from "lucide-react"
import {
  getAiSettings,
  saveAiSettings,
  type AiSettingsStatus,
} from "@/api"
import { defaultAiModel } from "@/ai/ai-settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export function AiSettingsCard() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  })
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [enabled, setEnabled] = useState(false)
  const saveMutation = useMutation({
    mutationFn: saveAiSettings,
    onSuccess: async (saved: AiSettingsStatus) => {
      setApiKey("")
      setModel(saved.model)
      setEnabled(saved.enabled)
      queryClient.setQueryData(["ai-settings"], saved)
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] })
    },
  })

  useEffect(() => {
    if (!settingsQuery.data) return
    setModel(settingsQuery.data.model)
    setEnabled(settingsQuery.data.enabled)
  }, [settingsQuery.data])

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    retrySaveSettings()
  }

  function retrySaveSettings() {
    saveMutation.mutate({
      apiKey: apiKey || undefined,
      model: model || undefined,
      enabled,
    })
  }

  const apiKeyConfigured = settingsQuery.data?.apiKeyConfigured ?? false
  const fieldInputClassName = "rounded-md border-border bg-background"

  return (
    <Card className="rounded-md border-border p-5 shadow-none">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Sparkles className="h-4 w-4" />
            AI mode
          </div>
          <Badge variant={settingsQuery.data?.enabled ? "default" : "secondary"}>
            {settingsQuery.data?.enabled ? "Enabled" : "Off"}
          </Badge>
        </div>
        <h2 className="mt-2 text-lg font-semibold tracking-normal text-foreground">
          Summaries with your OpenRouter key
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Off by default; the app is unchanged until you enable it. When
          enabled, pull request pages gain generate-on-demand summaries. Each
          generation sends that pull request's data (and its diff, for the
          change summary) to OpenRouter using your key and bills your
          OpenRouter account. Nothing is generated automatically.
        </p>
      </div>

      {settingsQuery.error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
          aria-label="Loading AI settings"
        >
          <div className="h-9 animate-pulse rounded-md bg-muted/60" />
          <div className="h-9 animate-pulse rounded-md bg-muted/60" />
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submitSettings}>
          <label className="flex flex-col gap-2">
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">OpenRouter API key</span>
              <Badge variant={apiKeyConfigured ? "default" : "secondary"}>
                {apiKeyConfigured ? "Key saved" : "Not configured"}
              </Badge>
            </span>
            <Input
              autoComplete="off"
              className={fieldInputClassName}
              placeholder={
                apiKeyConfigured
                  ? "Leave blank to keep the saved key"
                  : "sk-or-..."
              }
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="text-xs leading-5 text-muted-foreground">
              Stored in the same encrypted local Stronghold vault as your
              GitHub token. Create one at openrouter.ai/keys.
            </span>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Model</span>
            <Input
              className={fieldInputClassName}
              placeholder={defaultAiModel}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Any OpenRouter model id. Leave blank for {defaultAiModel}.
            </span>
          </label>

          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              checked={enabled}
              className="h-4 w-4 accent-primary"
              type="checkbox"
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable AI mode
          </label>

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
              AI settings saved.
            </div>
          ) : null}

          <div className="flex justify-end pt-2">
            <Button
              className="rounded-md"
              disabled={saveMutation.isPending}
              type="submit"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Save AI settings
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}
