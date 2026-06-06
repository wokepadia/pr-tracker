import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  KeyRound,
} from "lucide-react"
import { getGithubSettingsStatus } from "@/api"
import { GithubSettingsForm } from "@/components/GithubSettingsForm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export function SettingsPage() {
  const settingsQuery = useQuery({
    queryKey: ["github-settings"],
    queryFn: getGithubSettingsStatus,
  })

  const tokenConfigured = settingsQuery.data?.tokenConfigured ?? false
  const storageDescription =
    settingsQuery.data?.storage === "os-keychain"
      ? "Saved tokens are stored in the operating system keychain, not in the browser."
      : "Saved tokens are stored by the API in macOS Keychain, not in the browser."

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
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                Token storage
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {storageDescription}
              </div>
            </div>
            <Badge variant={tokenConfigured ? "default" : "secondary"}>
              {tokenConfigured ? "Token saved" : "Not configured"}
            </Badge>
          </div>

          <Separator className="my-5" />

          <GithubSettingsForm settings={settingsQuery.data} />
        </Card>
      </div>
    </div>
  )
}
