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
  storage: "macos-keychain" | "stronghold"
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

let desktopApiPromise: Promise<typeof import("./desktop/tauri-data")> | undefined

function getDesktopApi(): Promise<typeof import("./desktop/tauri-data")> {
  desktopApiPromise ??= import("./desktop/tauri-data")
  return desktopApiPromise
}

export async function getReviewerInbox(input?: {
  githubSearchQuery?: string
}): Promise<ReviewerInbox> {
  return (await getDesktopApi()).getDesktopReviewerInbox(input)
}

export async function getPullRequest(
  id: string
): Promise<PullRequestDetailResponse> {
  return (await getDesktopApi()).getDesktopPullRequest(id)
}

export async function markPullRequestSeen(id: string): Promise<{
  pullRequestId: string
  lastSeenAt: string
}> {
  return (await getDesktopApi()).markDesktopPullRequestSeen(id)
}

export async function getBoardState(): Promise<BoardState> {
  return (await getDesktopApi()).getDesktopBoardState()
}

export async function saveBoardState(state: BoardState): Promise<BoardState> {
  return (await getDesktopApi()).saveDesktopBoardState(state)
}

export async function getGithubSettingsStatus(): Promise<GithubSettingsStatus> {
  return (await getDesktopApi()).getDesktopGithubSettingsStatus()
}

export async function saveGithubSettings(
  input: SaveGithubSettingsInput
): Promise<GithubSettingsStatus> {
  return (await getDesktopApi()).saveDesktopGithubSettings(input)
}

export async function createSqliteBackup(): Promise<SqliteBackupResult> {
  return (await getDesktopApi()).createDesktopSqliteBackup()
}

export async function getOnboardingState(): Promise<OnboardingState> {
  return (await getDesktopApi()).getDesktopOnboardingState()
}

export async function saveOnboardingState(
  input: Partial<OnboardingState>
): Promise<OnboardingState> {
  return (await getDesktopApi()).saveDesktopOnboardingState(input)
}
