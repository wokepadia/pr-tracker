import type { Actor } from "@pr-tracker/core"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
} from "@pr-tracker/reviewer-workflow"
import type { PrBriefContent } from "@/ai/pr-brief"
import type {
  AiDashboardContent,
  AiDashboardInput,
} from "@/ai/ai-dashboard"

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

export interface AttentionSettings {
  elevatedAfterHours: number
  overdueAfterHours: number
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

export interface SyncGithubDataInput {
  githubSearchQuery?: string
  force?: boolean
}

export interface SyncGithubDataResult {
  status: "synced" | "already-fresh" | "no-credentials"
}

export interface SyncStatus {
  lastSyncedAt?: string
}

export interface InsightsVisit {
  /** Last insights visit before this app session, if any. Stable for the
   * whole session so the "while you were away" window does not collapse. */
  previousVisitAt?: string
}

export interface SaveGithubSettingsInput {
  token?: string
  repositories: string
  viewerLogin?: string
  apiBaseUrl?: string
}

export interface AiSettingsStatus {
  enabled: boolean
  provider: "openrouter" | "codex"
  model: string
  apiKeyConfigured: boolean
}

/** A cached AI generation. `isStale` means the underlying data changed
 * since it was generated; the cached content still renders until the user
 * explicitly regenerates. */
export interface AiGenerated<T> {
  content: T
  generatedAt: string
  model: string
  isStale: boolean
}

export interface SaveAiSettingsInput {
  apiKey?: string
  provider?: string
  model?: string
  enabled: boolean
}

export interface BoardState {
  /** One entry per pull request on the board. Presence is the membership
   * signal every board-scoped surface keys on; the value carries the
   * reviewer's private per-PR state. */
  localQueueState: BoardScopeState
}

/** Per-pull-request local state that survives outside GitHub. */
export interface BoardItemLocalState {
  notes?: string
}

export type BoardScopeState = Partial<Record<string, BoardItemLocalState>>

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

export async function getPullRequestNotes(
  id: string
): Promise<{ notes: string }> {
  return (await getDesktopApi()).getDesktopPullRequestNotes(id)
}

export async function savePullRequestNotes(
  id: string,
  notes: string
): Promise<{ notes: string }> {
  return (await getDesktopApi()).saveDesktopPullRequestNotes(id, notes)
}

export async function syncGithubData(
  input?: SyncGithubDataInput
): Promise<SyncGithubDataResult> {
  return (await getDesktopApi()).syncDesktopGithubData(input)
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return (await getDesktopApi()).getDesktopSyncStatus()
}

export async function visitInsights(): Promise<InsightsVisit> {
  return (await getDesktopApi()).visitDesktopInsights()
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

export async function getAttentionSettings(): Promise<AttentionSettings> {
  return (await getDesktopApi()).getDesktopAttentionSettings()
}

export async function saveAttentionSettings(
  input: AttentionSettings
): Promise<AttentionSettings> {
  return (await getDesktopApi()).saveDesktopAttentionSettings(input)
}

export async function getAiSettings(): Promise<AiSettingsStatus> {
  return (await getDesktopApi()).getDesktopAiSettings()
}

export async function saveAiSettings(
  input: SaveAiSettingsInput
): Promise<AiSettingsStatus> {
  return (await getDesktopApi()).saveDesktopAiSettings(input)
}

export async function getAiPrBrief(
  pullRequestId: string
): Promise<AiGenerated<PrBriefContent> | null> {
  return (await getDesktopApi()).getDesktopAiPrBrief(pullRequestId)
}

export async function generateAiPrBrief(
  pullRequestId: string
): Promise<AiGenerated<PrBriefContent>> {
  return (await getDesktopApi()).generateDesktopAiPrBrief(pullRequestId)
}

export async function getAiDashboard(
  input: AiDashboardInput
): Promise<AiGenerated<AiDashboardContent> | null> {
  return (await getDesktopApi()).getDesktopAiDashboard(input)
}

export async function generateAiDashboard(
  input: AiDashboardInput
): Promise<AiGenerated<AiDashboardContent>> {
  return (await getDesktopApi()).generateDesktopAiDashboard(input)
}

export async function getOnboardingState(): Promise<OnboardingState> {
  return (await getDesktopApi()).getDesktopOnboardingState()
}

export async function saveOnboardingState(
  input: Partial<OnboardingState>
): Promise<OnboardingState> {
  return (await getDesktopApi()).saveDesktopOnboardingState(input)
}
