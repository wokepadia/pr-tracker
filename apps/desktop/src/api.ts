import type { Actor } from "@pr-tracker/core"
import type {
  ClassifiedPullRequest,
  ReviewerInbox,
} from "@pr-tracker/reviewer-workflow"
import type {
  CatchUpDigestContent,
  PrSummaryContent,
  ThreadStateContent,
} from "@/ai/summaries"
import type {
  QueueBriefContent,
  QueueBriefInput,
} from "@/ai/queue-brief"

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
  model?: string
  enabled: boolean
}

export interface BoardState {
  buckets: Array<{ id: string; label: string }>
  localQueueState: Partial<Record<
    string,
    {
      snoozed?: boolean
      snoozedAt?: string
      pinned?: boolean
      muted?: boolean
      mutedAt?: string
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

export async function getAiPrSummary(
  pullRequestId: string
): Promise<AiGenerated<PrSummaryContent> | null> {
  return (await getDesktopApi()).getDesktopAiPrSummary(pullRequestId)
}

export async function generateAiPrSummary(
  pullRequestId: string
): Promise<AiGenerated<PrSummaryContent>> {
  return (await getDesktopApi()).generateDesktopAiPrSummary(pullRequestId)
}

export async function getAiCatchUpDigest(
  pullRequestId: string
): Promise<AiGenerated<CatchUpDigestContent> | null> {
  return (await getDesktopApi()).getDesktopAiCatchUpDigest(pullRequestId)
}

export async function generateAiCatchUpDigest(
  pullRequestId: string
): Promise<AiGenerated<CatchUpDigestContent>> {
  return (await getDesktopApi()).generateDesktopAiCatchUpDigest(pullRequestId)
}

export async function getAiThreadState(
  pullRequestId: string
): Promise<AiGenerated<ThreadStateContent> | null> {
  return (await getDesktopApi()).getDesktopAiThreadState(pullRequestId)
}

export async function generateAiThreadState(
  pullRequestId: string
): Promise<AiGenerated<ThreadStateContent>> {
  return (await getDesktopApi()).generateDesktopAiThreadState(pullRequestId)
}

export async function getAiQueueBrief(
  input: QueueBriefInput
): Promise<AiGenerated<QueueBriefContent> | null> {
  return (await getDesktopApi()).getDesktopAiQueueBrief(input)
}

export async function generateAiQueueBrief(
  input: QueueBriefInput
): Promise<AiGenerated<QueueBriefContent>> {
  return (await getDesktopApi()).generateDesktopAiQueueBrief(input)
}

export async function getOnboardingState(): Promise<OnboardingState> {
  return (await getDesktopApi()).getDesktopOnboardingState()
}

export async function saveOnboardingState(
  input: Partial<OnboardingState>
): Promise<OnboardingState> {
  return (await getDesktopApi()).saveDesktopOnboardingState(input)
}
