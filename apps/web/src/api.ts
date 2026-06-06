import type { Actor } from "@pr-tracker/core"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
} from "@pr-tracker/reviewer-workflow"
import { isTauri } from "@tauri-apps/api/core"

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
  storage: "macos-keychain" | "os-keychain"
}

export interface OnboardingState {
  completedAt?: string
  introSkippedAt?: string
  version: number
}

export interface SqliteBackupResult {
  filename: string
  path?: string
}

export interface SaveGithubSettingsInput {
  token?: string
  repositories: string
  viewerLogin?: string
  apiBaseUrl?: string
}

export interface BoardState {
  buckets: Array<{ id: string; label: string }>
  localQueueState: Partial<Record<
    string,
    {
      snoozed?: boolean
      pinned?: boolean
      muted?: boolean
      bucketId?: string
      notes?: string
    }
  >>
  userBucketItemOrder: Record<string, string[]>
  bucketColumnWidths: Record<string, number>
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? ""
let desktopApiPromise: Promise<typeof import("./desktop/tauri-data")> | undefined

function getDesktopApi(): Promise<typeof import("./desktop/tauri-data")> {
  desktopApiPromise ??= import("./desktop/tauri-data")
  return desktopApiPromise
}

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`
}

export async function getReviewerInbox(input?: {
  githubSearchQuery?: string
}): Promise<ReviewerInbox> {
  if (isTauri()) {
    return (await getDesktopApi()).getDesktopReviewerInbox(input)
  }

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
  if (isTauri()) {
    return (await getDesktopApi()).getDesktopPullRequest(id)
  }

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
  if (isTauri()) {
    return (await getDesktopApi()).markDesktopPullRequestSeen(id)
  }

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

export async function getBoardState(): Promise<BoardState> {
  if (isTauri()) {
    return (await getDesktopApi()).getDesktopBoardState()
  }

  const response = await fetch(apiUrl("/api/board-state"))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load board state."))
  }

  return response.json() as Promise<BoardState>
}

export async function saveBoardState(state: BoardState): Promise<BoardState> {
  if (isTauri()) {
    return (await getDesktopApi()).saveDesktopBoardState(state)
  }

  const response = await fetch(apiUrl("/api/board-state"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  })

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to save board state."))
  }

  return response.json() as Promise<BoardState>
}

export async function getGithubSettingsStatus(): Promise<GithubSettingsStatus> {
  if (isTauri()) {
    return (await getDesktopApi()).getDesktopGithubSettingsStatus()
  }

  const response = await fetch(apiUrl("/api/local-settings/github"))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load GitHub settings."))
  }

  return response.json() as Promise<GithubSettingsStatus>
}

export async function saveGithubSettings(
  input: SaveGithubSettingsInput
): Promise<GithubSettingsStatus> {
  if (isTauri()) {
    return (await getDesktopApi()).saveDesktopGithubSettings(input)
  }

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

export async function createSqliteBackup(): Promise<SqliteBackupResult> {
  if (isTauri()) {
    return (await getDesktopApi()).createDesktopSqliteBackup()
  }

  const response = await fetch(apiUrl("/api/local-settings/sqlite-backup"))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to create SQLite backup."))
  }

  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ??
    `review-ninja-sqlite-backup-${backupTimestamp()}.sqlite`
  const backupUrl = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = backupUrl
  link.download = filename
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(backupUrl)

  return { filename }
}

export async function getOnboardingState(): Promise<OnboardingState> {
  if (isTauri()) {
    return (await getDesktopApi()).getDesktopOnboardingState()
  }

  const response = await fetch(apiUrl("/api/local-settings/onboarding"))

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to load onboarding state."))
  }

  return response.json() as Promise<OnboardingState>
}

export async function saveOnboardingState(
  input: Partial<OnboardingState>
): Promise<OnboardingState> {
  if (isTauri()) {
    return (await getDesktopApi()).saveDesktopOnboardingState(input)
  }

  const response = await fetch(apiUrl("/api/local-settings/onboarding"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await responseError(response, "Failed to save onboarding state."))
  }

  return response.json() as Promise<OnboardingState>
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

function filenameFromContentDisposition(value: string | null): string | undefined {
  const match = value?.match(/filename="([^"]+)"/)
  return match?.[1]
}

function backupTimestamp(now = new Date()): string {
  return now.toISOString().replaceAll(/\D/g, "").slice(0, 14)
}
