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
import { defaultAiModels, type AiProvider } from "@/ai/ai-settings"
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
  const [provider, setProvider] = useState<AiProvider>("openrouter")
  const [model, setModel] = useState("")
  const [enabled, setEnabled] = useState(false)
  const saveMutation = useMutation({
    mutationFn: saveAiSettings,
    onSuccess: async (saved: AiSettingsStatus) => {
      setApiKey("")
      setProvider(saved.provider)
      setModel(saved.model)
      setEnabled(saved.enabled)
      queryClient.setQueryData(["ai-settings"], saved)
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] })
    },
  })

  useEffect(() => {
    if (!settingsQuery.data) return
    setProvider(settingsQuery.data.provider)
    setModel(settingsQuery.data.model)
    setEnabled(settingsQuery.data.enabled)
  }, [settingsQuery.data])

  function switchProvider(next: AiProvider) {
    setProvider(next)
    // Model ids are provider-specific; swap the field to the new default
    // unless the user already typed a custom value for the new provider.
    setModel((current) => {
      const other: AiProvider = next === "codex" ? "openrouter" : "codex"
      return current === "" || current === defaultAiModels[other]
        ? defaultAiModels[next]
        : current
    })
  }

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    retrySaveSettings()
  }

  function retrySaveSettings() {
    saveMutation.mutate({
      apiKey: apiKey || undefined,
      provider,
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
          Summaries with your own AI access
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Off by default; the app is unchanged until you enable it. When
          enabled, pull request pages and insights gain generate-on-demand
          summaries. Each generation sends that pull request's data (and its
          diff, for the change summary) to the provider you pick below, on
          your own account. Nothing is generated automatically.
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
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Provider</legend>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                checked={provider === "openrouter"}
                className="mt-1 h-3.5 w-3.5 accent-primary"
                name="ai-provider"
                type="radio"
                onChange={() => switchProvider("openrouter")}
              />
              <span>
                <span className="font-medium">OpenRouter</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  Pay-per-use with your own API key. Calls go directly to
                  OpenRouter.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                checked={provider === "codex"}
                className="mt-1 h-3.5 w-3.5 accent-primary"
                name="ai-provider"
                type="radio"
                onChange={() => switchProvider("codex")}
              />
              <span>
                <span className="font-medium">Codex CLI (ChatGPT plan)</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  Uses the locally installed Codex CLI and its own sign-in,
                  so generations draw on your ChatGPT subscription. Requires
                  `codex login` in a terminal first. Note: consumer ChatGPT
                  plans may retain and train on prompts unless you disable
                  "Improve the model for everyone" in ChatGPT's Data
                  Controls.
                </span>
              </span>
            </label>
          </fieldset>

          {provider === "openrouter" ? (
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
          ) : null}

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">Model</span>
            <Input
              className={fieldInputClassName}
              placeholder={defaultAiModels[provider]}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              {provider === "openrouter"
                ? `Any OpenRouter model id. Leave blank for ${defaultAiModels.openrouter}.`
                : `A model your ChatGPT plan supports. Leave blank for ${defaultAiModels.codex}.`}
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
