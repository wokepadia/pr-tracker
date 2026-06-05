import type { Actor } from "@pr-tracker/core"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
} from "@pr-tracker/reviewer-workflow"

export interface PullRequestDetailResponse {
  viewer: Actor
  actors: Actor[]
  item: ClassifiedPullRequest
}

export interface GithubSettingsStatus {
  repositories: string[]
  viewerLogin?: string
  apiBaseUrl?: string
  tokenConfigured: boolean
  storage: "macos-keychain"
}

export interface SaveGithubSettingsInput {
  token?: string
  repositories: string
  viewerLogin?: string
  apiBaseUrl?: string
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? ""

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`
}

export async function getReviewerInbox(input?: {
  githubSearchQuery?: string
}): Promise<ReviewerInbox> {
  const params = new URLSearchParams()
  if (input?.githubSearchQuery?.trim()) {
    params.set("githubSearchQuery", input.githubSearchQuery.trim())
  }

  const response = await fetch(
    apiUrl(`/api/reviewer-inbox${params.size ? `?${params}` : ""}`)
  )

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load reviewer inbox."))
  }

  return response.json() as Promise<ReviewerInbox>
}

export async function getPullRequest(
  id: string
): Promise<PullRequestDetailResponse> {
  const response = await fetch(apiUrl(`/api/pull-requests/${id}`))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load pull request."))
  }

  return response.json() as Promise<PullRequestDetailResponse>
}

export async function markPullRequestSeen(id: string): Promise<{
  pullRequestId: string
  lastSeenAt: string
}> {
  const response = await fetch(apiUrl(`/api/pull-requests/${id}/seen`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastSeenAt: new Date().toISOString() }),
  })

  if (!response.ok) {
    throw new Error("Failed to mark pull request as seen.")
  }

  return response.json() as Promise<{
    pullRequestId: string
    lastSeenAt: string
  }>
}

export async function getGithubSettingsStatus(): Promise<GithubSettingsStatus> {
  const response = await fetch(apiUrl("/api/local-settings/github"))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load GitHub settings."))
  }

  return response.json() as Promise<GithubSettingsStatus>
}

export async function saveGithubSettings(
  input: SaveGithubSettingsInput
): Promise<GithubSettingsStatus> {
  const response = await fetch(apiUrl("/api/local-settings/github"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to save GitHub settings."))
  }

  return response.json() as Promise<GithubSettingsStatus>
}

async function responseError(
  response: Response,
  fallback: string
): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  }

  return body.error ?? fallback
}
