import type {
  Actor,
  PullRequestActivity,
  PullRequestComment,
  PullRequestItem,
  PullRequestLabel,
  ReviewDecisionEvent,
  ReviewRequestEvent,
  ReviewThread,
} from "@pr-tracker/core"
import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  mapConcurrent,
  parseGithubRepositories,
  type GitHubIssueCommentSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubReviewSnapshot,
  type GitHubReviewThreadSnapshot,
} from "@pr-tracker/github"
import { buildReviewerInbox } from "@pr-tracker/reviewer-workflow"
import { Command } from "@tauri-apps/plugin-shell"
import Database from "@tauri-apps/plugin-sql"
import {
  Stronghold,
  type Store as StrongholdStore,
} from "@tauri-apps/plugin-stronghold"
import {
  appDataDir,
  downloadDir,
  join,
} from "@tauri-apps/api/path"
import type {
  AiGenerated,
  AiSettingsStatus,
  AttentionSettings,
  BoardState,
  ChatMessageRecord,
  ChatThreadState,
  GithubSettingsStatus,
  OnboardingState,
  PullRequestDetailResponse,
  InsightsVisit,
  SaveAiSettingsInput,
  SaveGithubSettingsInput,
  SendChatMessageInput,
  SendChatMessageResult,
  SqliteBackupResult,
  SyncGithubDataResult,
  SyncStatus,
} from "@/api"
import {
  normalizeAiModel,
  normalizeAiProvider,
  normalizeStoredAiSettings,
  type AiProvider,
  type StoredAiSettings,
} from "@/ai/ai-settings"
import {
  requestCodexChat,
  requestCodexStructuredCompletion,
  type CodexExecResult,
} from "@/ai/codex"
import { hashContent } from "@/ai/content-hash"
import {
  requestOpenRouterChat,
  requestStructuredCompletion,
  type ChatTurn,
} from "@/ai/openrouter"
import { buildChatSystemPrompt } from "@/ai/chat"
import {
  aiDashboardSchema,
  aiDashboardSchemaName,
  buildAiDashboardPrompt,
  normalizeAiDashboardContent,
  type AiDashboardContent,
  type AiDashboardInput,
} from "@/ai/ai-dashboard"
import {
  buildPrBriefPrompt,
  normalizePrBriefContent,
  prBriefSchema,
  prBriefSchemaName,
  threadLocationKey,
  type PrBriefCommentInput,
  type PrBriefContent,
  type PrBriefEventInput,
  type PrBriefThreadInput,
} from "@/ai/pr-brief"
import {
  defaultAttentionThresholds,
  toReviewQueueItemView,
  type AttentionThresholds,
  type ReviewQueueItemView,
} from "@/reviewer/view-model"
import {
  applyMigrationsAsync,
  type AsyncMigrationDriver,
} from "../../../../packages/db/src/migrations"
import { createQueuedTransaction } from "./sqlite-transaction"

const databaseUrl = "sqlite:pr-tracker.sqlite"
const defaultLocalProfileId = "local"
const defaultLocalBoardId = "default-board"
const githubSettingsKey = "github-settings"
const onboardingSettingsKey = "onboarding"
const attentionSettingsKey = "attention_thresholds"
const insightsVisitSettingsKey = "insights-visit"
const lastSyncSuccessSettingsKey = "github-sync-last-success"
const githubSyncFreshnessMs = 5 * 60 * 1000
const githubSyncFailureCooldownMs = 60 * 1000
const closedPullRequestReadLookbackDays = 14
const strongholdPasswordSettingsKey = "stronghold-unlock-secret"
const githubTokenStoreKey = "github-token"
const strongholdClientName = "review-ninja"
const strongholdFilename = "github-token.stronghold"
const desktopTokenStorage = "stronghold"
const aiSettingsKey = "ai-settings"
const openRouterApiKeyStoreKey = "openrouter-api-key"
let cachedToken: string | undefined
let tokenReadPromise: Promise<string | undefined> | undefined
let cachedAiApiKey: string | undefined
let aiApiKeyReadPromise: Promise<string | undefined> | undefined
let strongholdSessionPromise: Promise<StrongholdSession> | undefined

type SqlValue = string | number | boolean | null

interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

interface LocalGithubSettings {
  repositories: string[]
  viewerLogin?: string
  apiBaseUrl?: string
  tokenConfigured: boolean
  tokenStorage?: typeof desktopTokenStorage
}

interface LocalGithubCredentials
  extends Omit<LocalGithubSettings, "tokenConfigured"> {
  token: string
}

interface LocalPullRequestRow {
  id: string
  repository_full_name: string
  number: number
  title: string
  body: string | null
  url: string
  author_login: string
  state: string
  is_draft: number
  latest_commit_sha: string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  github_created_at: string | null
  github_updated_at: string | null
  merged_at: string | null
  status_check_summary_json: string | null
  raw_payload_json: string
}

interface LocalPullRequestLabelRow {
  pull_request_id: string
  name: string
  color: string | null
  description: string | null
}

interface LocalPullRequestAssigneeRow {
  pull_request_id: string
  login: string
}

interface LocalBoardItemStateRow {
  pull_request_id: string
  last_seen_at: string | null
  notes: string | null
}

interface LocalReviewCommentRow {
  id: string
  review_thread_id: string | null
  pull_request_id: string
  author_login: string
  body: string
  file_path: string | null
  line: number | null
  created_at_github: string
  updated_at_github: string | null
  url: string | null
}

interface LocalIssueCommentRow {
  id: string
  pull_request_id: string
  author_login: string
  body: string
  created_at_github: string
  updated_at_github: string | null
  url: string | null
}

interface ReviewCommentInput {
  id: string
  reviewThreadId?: string
  githubNodeId: string
  authorLogin: string
  body: string
  filePath?: string
  line?: number
  createdAt: string
  updatedAt?: string | null
  url?: string | null
  rawPayload: unknown
}

type DiscussionCommentInput = PrBriefCommentInput

interface StrongholdSession {
  stronghold: Stronghold
  store: StrongholdStore
}

interface SyncScope {
  pullRequestIds?: string[]
}

interface SyncSuccess {
  finishedAtMs: number
  scope?: SyncScope
}

interface SyncBeforeReadResult {
  scope?: SyncScope
  didSync: boolean
  hasCredentials: boolean
}

let databasePromise: Promise<SqlDatabase> | undefined
let insightsVisitAnchor: { previousVisitAt?: string } | undefined
const lastSuccessfulSyncByFingerprint = new Map<string, SyncSuccess>()
const lastFailedSyncByFingerprint = new Map<
  string,
  { failedAtMs: number; error: unknown }
>()
const transaction = createQueuedTransaction<SqlDatabase>()
const syncPromiseByFingerprint = new Map<
  string,
  Promise<SyncBeforeReadResult>
>()

export async function getDesktopReviewerInbox(input?: {
  githubSearchQuery?: string
}) {
  const db = await getDatabase()
  const githubSearchQuery = cleanGithubSearchQuery(input?.githubSearchQuery)
  // Reads are local-only. For a filtered board, the last successful sync
  // leaves durable membership rows that answer which cached PRs are in scope.
  const scopedPullRequestIds = githubSearchQuery
    ? await loadBoardFilterMembershipPullRequestIds(db, githubSearchQuery)
    : undefined
  const pullRequests = await loadPullRequests(db, {
    ids: githubSearchQuery ? scopedPullRequestIds : undefined,
  })
  const viewerLogin = await resolveViewerLogin(db)
  const actors = buildActors(
    pullRequests,
    [viewerLogin],
    await loadAvatarUrlsByLogin(db)
  )
  const viewer = ensureActor(actors, viewerLogin)
  const lastSeenAtByPullRequestId = await loadLastSeen(db)

  return buildReviewerInbox({
    viewer,
    actors,
    pullRequests,
    now: new Date().toISOString(),
    lastSeenAtByPullRequestId,
  })
}

export async function getDesktopPullRequest(
  id: string
): Promise<PullRequestDetailResponse> {
  const db = await getDatabase()
  const pullRequests = await loadPullRequests(db, id)
  const pullRequest = pullRequests[0]
  if (!pullRequest) {
    throw new Error("Pull request not found.")
  }

  const viewerLogin = await resolveViewerLogin(db)
  const actors = buildActors(
    pullRequests,
    [viewerLogin],
    await loadAvatarUrlsByLogin(db)
  )
  const viewer = ensureActor(actors, viewerLogin)
  const inbox = buildReviewerInbox({
    viewer,
    actors,
    pullRequests,
    now: new Date().toISOString(),
    lastSeenAtByPullRequestId: await loadLastSeen(db),
  })
  const item = inbox.items[0]
  if (!item) {
    throw new Error("Pull request not found.")
  }

  return { viewer, actors, item }
}

export async function markDesktopPullRequestSeen(id: string): Promise<{
  pullRequestId: string
  lastSeenAt: string
}> {
  const db = await getDatabase()
  const lastSeenAt = new Date().toISOString()
  const result = await db.execute(
    `
      update board_items
      set last_seen_at = $1, updated_at = $2
      where board_id = $3 and pull_request_id = $4
    `,
    [lastSeenAt, lastSeenAt, defaultLocalBoardId, id]
  )

  if (result.rowsAffected === 0) {
    throw new Error("Pull request not found.")
  }

  return { pullRequestId: id, lastSeenAt }
}

export async function getDesktopBoardState(): Promise<BoardState> {
  const db = await getDatabase()
  return loadBoardState(db)
}

export async function syncDesktopGithubData(input?: {
  githubSearchQuery?: string
  force?: boolean
}): Promise<SyncGithubDataResult> {
  const db = await getDatabase()
  const { didSync, hasCredentials } = await syncBeforeRead(db, {
    githubSearchQuery: input?.githubSearchQuery,
    force: input?.force,
  })
  // "synced" means local data changed (a GitHub sync landed); callers
  // refresh their reads only for this status.
  if (didSync) {
    return { status: "synced" }
  }
  return { status: hasCredentials ? "already-fresh" : "no-credentials" }
}

export async function visitDesktopInsights(): Promise<InsightsVisit> {
  const db = await getDatabase()

  // The anchor stays fixed for the whole app session so revisits keep the
  // same "since you were last here" window; only the stored value advances.
  if (!insightsVisitAnchor) {
    let previousVisitAt: string | undefined
    const raw = await readAppSetting(db, insightsVisitSettingsKey)
    if (raw) {
      const parsed = JSON.parse(raw) as { value?: unknown }
      if (typeof parsed.value === "string" && parsed.value.length > 0) {
        previousVisitAt = parsed.value
      }
    }
    insightsVisitAnchor = { previousVisitAt }
  }

  await writeAppSetting(db, insightsVisitSettingsKey, {
    value: new Date().toISOString(),
  })
  return insightsVisitAnchor
}

export async function getDesktopSyncStatus(): Promise<SyncStatus> {
  const db = await getDatabase()
  const rows = await db.select<Array<{ finished_at: string | null }>>(
    `
      select finished_at from sync_runs
      where status = 'succeeded' and finished_at is not null
      order by finished_at desc
      limit 1
    `
  )
  return { lastSyncedAt: rows[0]?.finished_at ?? undefined }
}

export async function getDesktopPullRequestNotes(
  id: string
): Promise<{ notes: string }> {
  const db = await getDatabase()
  const row = (
    await db.select<Array<{ notes: string | null }>>(
      `
        select notes from board_items
        where board_id = $1 and pull_request_id = $2
      `,
      [defaultLocalBoardId, id]
    )
  )[0]
  return { notes: row?.notes ?? "" }
}

export async function saveDesktopPullRequestNotes(
  id: string,
  notes: string
): Promise<{ notes: string }> {
  const db = await getDatabase()
  const now = new Date().toISOString()
  const cleaned = cleanOptionalText(notes)
  const result = await db.execute(
    `
      update board_items
      set notes = $1, updated_at = $2
      where board_id = $3 and pull_request_id = $4
    `,
    [cleaned, now, defaultLocalBoardId, id]
  )

  if (result.rowsAffected === 0) {
    throw new Error("Pull request not found.")
  }

  return { notes: cleaned ?? "" }
}

export async function getDesktopGithubSettingsStatus(): Promise<GithubSettingsStatus> {
  const db = await getDatabase()
  const settings = await readLocalGithubSettings(db)
  const tokenConfigured = settings.tokenConfigured
    ? Boolean(await readToken(db))
    : false

  return {
    repositories: settings.repositories,
    viewerLogin: settings.viewerLogin,
    apiBaseUrl: settings.apiBaseUrl,
    tokenConfigured,
    storage: "stronghold",
  }
}

export async function saveDesktopGithubSettings(
  input: SaveGithubSettingsInput
): Promise<GithubSettingsStatus> {
  const db = await getDatabase()
  const repositories = parseGithubRepositories(input.repositories)
  if (repositories.length === 0) {
    throw new Error("At least one GitHub repository is required.")
  }

  const token = input.token?.trim()
  const existingSettings = await readLocalGithubSettings(db)
  let tokenConfigured = false

  if (token) {
    await writeToken(db, token)
    tokenConfigured = true
  }

  if (!tokenConfigured) {
    tokenConfigured =
      existingSettings.tokenConfigured && Boolean(await readToken(db))
  }

  if (!tokenConfigured) {
    throw new Error("A GitHub token is required.")
  }

  await writeLocalGithubSettings(db, {
    repositories,
    viewerLogin: cleanOptionalString(input.viewerLogin),
    apiBaseUrl: cleanOptionalString(input.apiBaseUrl),
    tokenConfigured,
    tokenStorage: desktopTokenStorage,
  })
  lastSuccessfulSyncByFingerprint.clear()
  lastFailedSyncByFingerprint.clear()

  return {
    repositories,
    viewerLogin: cleanOptionalString(input.viewerLogin),
    apiBaseUrl: cleanOptionalString(input.apiBaseUrl),
    tokenConfigured,
    storage: "stronghold",
  }
}

export async function createDesktopSqliteBackup(): Promise<SqliteBackupResult> {
  const db = await getDatabase()
  const filename = `review-ninja-sqlite-backup-${backupTimestamp()}.sqlite`
  const path = await join(await downloadDir(), filename)

  await db.execute(`vacuum main into ${sqliteStringLiteral(path)}`)

  return { filename, path }
}

export async function getDesktopAttentionSettings(): Promise<AttentionSettings> {
  const db = await getDatabase()
  const raw = await readAppSetting(db, attentionSettingsKey)
  if (!raw) return { ...defaultAttentionThresholds }

  try {
    return normalizeAttentionSettings(JSON.parse(raw))
  } catch {
    return { ...defaultAttentionThresholds }
  }
}

export async function saveDesktopAttentionSettings(
  input: AttentionSettings
): Promise<AttentionSettings> {
  const db = await getDatabase()
  const settings = normalizeAttentionSettings(input)
  await writeAppSetting(db, attentionSettingsKey, settings)
  return settings
}

function normalizeAttentionSettings(value: unknown): AttentionSettings {
  const parsed = (value ?? {}) as Partial<AttentionSettings>
  const elevatedAfterHours = normalizeThresholdHours(
    parsed.elevatedAfterHours,
    defaultAttentionThresholds.elevatedAfterHours
  )
  const overdueAfterHours = Math.max(
    normalizeThresholdHours(
      parsed.overdueAfterHours,
      defaultAttentionThresholds.overdueAfterHours
    ),
    elevatedAfterHours
  )
  return { elevatedAfterHours, overdueAfterHours }
}

function normalizeThresholdHours(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback
  }
  return Math.round(value)
}

export async function getDesktopAiSettings(): Promise<AiSettingsStatus> {
  const db = await getDatabase()
  const stored = await readLocalAiSettings(db)
  // Verify the key still exists in Stronghold only when settings claim one,
  // so loading the settings page never creates the vault by itself.
  const apiKeyConfigured = stored.apiKeyConfigured
    ? Boolean(await readAiApiKey(db))
    : false

  return {
    enabled: stored.enabled,
    provider: stored.provider,
    model: stored.model,
    apiKeyConfigured,
  }
}

export async function saveDesktopAiSettings(
  input: SaveAiSettingsInput
): Promise<AiSettingsStatus> {
  const db = await getDatabase()
  const existing = await readLocalAiSettings(db)
  const apiKey = input.apiKey?.trim()
  let apiKeyConfigured = false

  if (apiKey) {
    await writeAiApiKey(db, apiKey)
    apiKeyConfigured = true
  } else {
    apiKeyConfigured =
      existing.apiKeyConfigured && Boolean(await readAiApiKey(db))
  }

  const provider = normalizeAiProvider(input.provider)
  if (input.enabled && provider === "openrouter" && !apiKeyConfigured) {
    throw new Error("An OpenRouter API key is required to enable AI mode.")
  }

  const settings: StoredAiSettings = {
    enabled: input.enabled,
    provider,
    model: normalizeAiModel(input.model, provider),
    apiKeyConfigured,
  }
  await writeAppSetting(db, aiSettingsKey, settings)
  return settings
}

export async function getDesktopAiPrBrief(
  pullRequestId: string
): Promise<AiGenerated<PrBriefContent> | null> {
  const db = await getDatabase()
  const row = await readAiSummaryRow(db, pullRequestId, "pr-brief")
  if (!row) {
    // null, not undefined: TanStack Query rejects undefined query data.
    return null
  }

  const settings = await readLocalAiSettings(db)
  const { allowedFiles } = await loadPrBriefThreads(db, pullRequestId)
  const expectedKey = await prBriefCacheKey(db, pullRequestId, settings.model)

  return {
    content: normalizePrBriefContent(JSON.parse(row.content_json), allowedFiles),
    generatedAt: row.generated_at,
    model: row.model,
    isStale: expectedKey !== row.cache_key,
  }
}

export async function generateDesktopAiPrBrief(
  pullRequestId: string
): Promise<AiGenerated<PrBriefContent>> {
  const db = await getDatabase()
  const config = await requireActiveAiConfig(db)
  const pullRequest = (await listPullRequestRows(db, { id: pullRequestId }))[0]
  if (!pullRequest) {
    throw new Error("Pull request not found.")
  }

  const credentials = await loadLocalGithubCredentials(db)
  if (!credentials) {
    throw new Error(
      "Generating a brief needs GitHub access to fetch the diff. Configure GitHub in Settings first."
    )
  }

  // The board can track pull requests from repositories outside the
  // explicitly configured list (a search-query board pulls them in), so allow
  // the diff fetch for this already-tracked pull request's own repository.
  const source = createGithubTokenPullRequestSource({
    ...credentials,
    repositories: [
      ...new Set([...credentials.repositories, pullRequest.repository_full_name]),
    ],
  })
  const files = await source.listPullRequestChangedFiles({
    repository: pullRequest.repository_full_name,
    number: pullRequest.number,
  })
  if (!files) {
    throw new Error(
      "GitHub returned no changed files for this pull request, so there is no diff to brief."
    )
  }

  const { item } = await loadPullRequestView(db, pullRequestId)
  const { threads, allowedFiles } = await loadPrBriefThreads(db, pullRequestId)
  const comments = await listDiscussionComments(db, pullRequestId)
  const newEvents = await loadPrBriefNewEvents(db, pullRequestId)

  const prompt = buildPrBriefPrompt({
    repository: item.repository,
    number: item.number,
    title: item.title,
    body: pullRequest.body ?? undefined,
    authorLogin: item.authorLogin,
    viewerLogin: await resolveViewerLogin(db),
    state: item.state,
    isDraft: pullRequest.is_draft === 1,
    additions: item.size?.additions,
    deletions: item.size?.deletions,
    changedFiles: item.size?.fileCount,
    waitingOn: item.waitingOn,
    waitingAge: item.waitingAge,
    waitingUrgency: item.waitingUrgency,
    isStalled: isItemStalled(item),
    reason: item.reason,
    userLastReviewDecision: item.userLastReviewDecision,
    approvalStale: item.approvalStale,
    reviewRounds: item.reviewRounds,
    checksState: item.checks?.state,
    lastSeenLabel: item.lastSeenAtIso ? item.lastSeenAt : undefined,
    otherReviewers: item.otherReviewers.map((reviewer) => ({
      login: reviewer.login,
      decision: reviewer.decision,
    })),
    newEvents,
    threads,
    comments,
    files,
  })

  const content = normalizePrBriefContent(
    await runStructuredAiCompletion<PrBriefContent>(config, {
      system: prompt.system,
      user: prompt.user,
      schemaName: prBriefSchemaName,
      schema: prBriefSchema,
    }),
    allowedFiles
  )

  const generatedAt = new Date().toISOString()
  await writeAiSummaryRow(db, pullRequestId, "pr-brief", {
    cacheKey: await prBriefCacheKey(db, pullRequestId, config.model),
    model: config.model,
    contentJson: JSON.stringify(content),
    generatedAt,
  })

  return { content, generatedAt, model: config.model, isStale: false }
}

const aiDashboardSentinelId = "queue"

export async function getDesktopAiDashboard(
  input: AiDashboardInput
): Promise<AiGenerated<AiDashboardContent> | null> {
  const db = await getDatabase()
  const row = await readAiSummaryRow(db, aiDashboardSentinelId, "ai-dashboard")
  if (!row) {
    return null
  }

  const settings = await readLocalAiSettings(db)
  const enrichedInput = await enrichAiDashboardInputWithComments(db, input)
  const prompt = buildAiDashboardPrompt(enrichedInput)
  const expectedKey = await hashContent(
    `ai-dashboard\n${settings.model}\n${prompt.user}`
  )

  return {
    content: normalizeAiDashboardContent(
      JSON.parse(row.content_json),
      enrichedInput.items.map((item) => item.id)
    ),
    generatedAt: row.generated_at,
    model: row.model,
    isStale: expectedKey !== row.cache_key,
  }
}

export async function generateDesktopAiDashboard(
  input: AiDashboardInput
): Promise<AiGenerated<AiDashboardContent>> {
  const db = await getDatabase()
  const config = await requireActiveAiConfig(db)
  if (input.items.length === 0) {
    throw new Error("There are no open reviews to brief right now.")
  }

  const enrichedInput = await enrichAiDashboardInputWithComments(db, input)
  const prompt = buildAiDashboardPrompt(enrichedInput)
  const content = normalizeAiDashboardContent(
    await runStructuredAiCompletion<AiDashboardContent>(config, {
      system: prompt.system,
      user: prompt.user,
      schemaName: aiDashboardSchemaName,
      schema: aiDashboardSchema,
    }),
    enrichedInput.items.map((item) => item.id)
  )

  const generatedAt = new Date().toISOString()
  await writeAiSummaryRow(db, aiDashboardSentinelId, "ai-dashboard", {
    cacheKey: await hashContent(
      `ai-dashboard\n${config.model}\n${prompt.user}`
    ),
    model: config.model,
    contentJson: JSON.stringify(content),
    generatedAt,
  })

  return { content, generatedAt, model: config.model, isStale: false }
}

const maxChatHistoryMessages = 40

export async function getDesktopChatThread(
  boardFingerprint: string
): Promise<ChatThreadState> {
  const db = await getDatabase()
  const thread = await loadActiveChatThread(db, boardFingerprint)
  if (!thread) {
    return { threadId: "", messages: [] }
  }
  return { threadId: thread, messages: await loadChatMessages(db, thread) }
}

export async function sendDesktopChatMessage(
  input: SendChatMessageInput
): Promise<SendChatMessageResult> {
  const db = await getDatabase()
  const config = await requireActiveAiConfig(db)
  const message = input.message.trim()
  if (!message) {
    throw new Error("Type a question to ask about your board.")
  }

  // Resolve the thread up front but do not persist the user turn until the AI
  // call succeeds, so a failed request never leaves a dangling message.
  let threadId = input.threadId
  if (threadId) {
    const exists = await db.select<Array<{ id: string }>>(
      `select id from chat_threads where id = $1 and archived_at is null`,
      [threadId]
    )
    if (exists.length === 0) {
      threadId = ""
    }
  }

  const history = threadId ? await loadChatMessages(db, threadId) : []
  const turns: ChatTurn[] = [
    ...history
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .slice(-maxChatHistoryMessages)
      .map((entry) => ({
        role: entry.role as "user" | "assistant",
        content: entry.content,
      })),
    { role: "user", content: message },
  ]

  const enrichedInput = await enrichAiDashboardInputWithComments(
    db,
    input.dashboardInput
  )
  const system = buildChatSystemPrompt(enrichedInput)
  const answer = (await runChatAiCompletion(config, { system, messages: turns })).trim()
  if (!answer) {
    throw new Error("The model returned an empty answer. Try again.")
  }

  const now = new Date().toISOString()
  if (!threadId) {
    threadId = await createChatThread(db, {
      boardFingerprint: input.boardFingerprint,
      title: chatThreadTitle(message),
      now,
    })
  }

  const userMessage = await appendChatMessage(db, {
    threadId,
    role: "user",
    content: message,
    createdAt: now,
  })
  const assistantMessage = await appendChatMessage(db, {
    threadId,
    role: "assistant",
    content: answer,
    model: config.model,
    createdAt: new Date().toISOString(),
  })
  await db.execute(`update chat_threads set updated_at = $1 where id = $2`, [
    assistantMessage.createdAt,
    threadId,
  ])

  return { threadId, userMessage, assistantMessage }
}

export async function clearDesktopChatThread(
  boardFingerprint: string
): Promise<ChatThreadState> {
  const db = await getDatabase()
  await db.execute(
    `
      update chat_threads
      set archived_at = $1
      where board_fingerprint = $2 and archived_at is null
    `,
    [new Date().toISOString(), boardFingerprint]
  )
  return { threadId: "", messages: [] }
}

async function loadActiveChatThread(
  db: SqlDatabase,
  boardFingerprint: string
): Promise<string | undefined> {
  const rows = await db.select<Array<{ id: string }>>(
    `
      select id from chat_threads
      where board_fingerprint = $1 and archived_at is null
      order by updated_at desc
      limit 1
    `,
    [boardFingerprint]
  )
  return rows[0]?.id
}

async function loadChatMessages(
  db: SqlDatabase,
  threadId: string
): Promise<ChatMessageRecord[]> {
  const rows = await db.select<
    Array<{
      id: string
      role: string
      content: string
      model: string | null
      created_at: string
    }>
  >(
    `
      select id, role, content, model, created_at
      from chat_messages
      where thread_id = $1
      order by created_at asc, id asc
    `,
    [threadId]
  )
  return rows.map((row) => ({
    id: row.id,
    role: row.role as ChatMessageRecord["role"],
    content: row.content,
    model: row.model ?? undefined,
    createdAt: row.created_at,
  }))
}

async function createChatThread(
  db: SqlDatabase,
  input: { boardFingerprint: string; title: string; now: string }
): Promise<string> {
  const id = deterministicUuid(
    `chat-thread:${input.boardFingerprint}:${input.now}:${Math.random()}`
  )
  await db.execute(
    `
      insert into chat_threads (
        id, board_fingerprint, title, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5)
    `,
    [id, input.boardFingerprint, input.title, input.now, input.now]
  )
  return id
}

async function appendChatMessage(
  db: SqlDatabase,
  input: {
    threadId: string
    role: ChatMessageRecord["role"]
    content: string
    model?: string
    createdAt: string
  }
): Promise<ChatMessageRecord> {
  const id = deterministicUuid(
    `chat-message:${input.threadId}:${input.role}:${input.createdAt}:${Math.random()}`
  )
  await db.execute(
    `
      insert into chat_messages (id, thread_id, role, content, model, created_at)
      values ($1, $2, $3, $4, $5, $6)
    `,
    [id, input.threadId, input.role, input.content, input.model ?? null, input.createdAt]
  )
  return {
    id,
    role: input.role,
    content: input.content,
    model: input.model,
    createdAt: input.createdAt,
  }
}

function chatThreadTitle(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed
}

export async function getDesktopOnboardingState(): Promise<OnboardingState> {
  const db = await getDatabase()
  return readOnboardingState(db)
}

export async function saveDesktopOnboardingState(
  input: Partial<OnboardingState>
): Promise<OnboardingState> {
  const db = await getDatabase()
  const state: OnboardingState = {
    version: normalizeOnboardingVersion(input.version),
    completedAt: cleanOptionalString(input.completedAt),
    introSkippedAt: cleanOptionalString(input.introSkippedAt),
  }
  await writeAppSetting(db, onboardingSettingsKey, state)
  return state
}

async function getDatabase(): Promise<SqlDatabase> {
  databasePromise ??= initializeDatabase()
  return databasePromise
}

async function initializeDatabase(): Promise<SqlDatabase> {
  const db = await Database.load(databaseUrl)
  // The SQL plugin hands statements to a pool of connections, so a pragma
  // executed here only configures whichever connection runs it. Per-
  // connection settings (busy_timeout = 5s, foreign_keys = on) come from
  // sqlx defaults applied to every pooled connection. journal_mode is a
  // property of the database file itself, so setting it once here is
  // enough: WAL lets readers proceed while another window writes.
  await db.execute("pragma journal_mode = wal")
  // Legacy cleanups that predate the migration ledger and involve drops or
  // table rebuilds rather than forward schema changes. Both are guarded, so
  // they are no-ops on a fresh database.
  await migrateLegacyBoardItems(db)
  // Drop the stale AI cache so the base-schema migration rebuilds it with the
  // current kind constraint; dropping its ledger row forces that re-run.
  await dropOutdatedAiSummariesTable(db)
  // The shared, versioned migration ledger brings the schema to the current
  // shape. The same migration list runs on the node:sqlite path in tests.
  await applyMigrationsAsync(asyncMigrationDriver(db))
  return db
}

function asyncMigrationDriver(db: SqlDatabase): AsyncMigrationDriver {
  return {
    async exec(sql) {
      await db.execute(sql)
    },
    query(sql) {
      return db.select(sql)
    },
  }
}

/**
 * ai_summaries is a pure cache with a check constraint over the kind list.
 * When an existing database predates a newly added kind, drop the table
 * before the schema run so create-if-not-exists rebuilds it with the
 * current constraint; cached summaries are regenerated on demand.
 */
async function dropOutdatedAiSummariesTable(db: SqlDatabase): Promise<void> {
  const rows = await db.select<Array<{ sql: string | null }>>(
    `select sql from sqlite_master where type = 'table' and name = 'ai_summaries'`
  )
  const createSql = rows[0]?.sql
  if (createSql && !createSql.includes("'pr-brief'")) {
    await db.execute(`drop table ai_summaries`)
    // Force the base-schema migration to re-run so its create-if-not-exists
    // rebuilds the dropped cache table with the current kind constraint. Every
    // other table in that migration already exists, so the replay only
    // recreates ai_summaries.
    await db.execute(
      `create table if not exists schema_migrations (id text primary key, applied_at text not null default current_timestamp)`
    )
    await db.execute(
      `delete from schema_migrations where id = '0001-base-schema'`
    )
  }
}

/**
 * Removes the Kanban board for good: the lanes table (board_columns) and the
 * per-item placement and triage columns on board_items (column ordering,
 * snooze, mute, pin, and the denormalized viewer-classification fields). A
 * board item now records only membership plus the reviewer's last-seen marker
 * and notes. Uses the standard SQLite table rebuild so the columns and their
 * data are physically gone, not just unused.
 */
async function migrateLegacyBoardItems(db: SqlDatabase): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>(
    `pragma table_info(board_items)`
  )
  const columnNames = new Set(columns.map((row) => row.name))
  const legacyColumns = [
    "column_id",
    "sort_order",
    "last_seen_activity_at",
    "viewer_is_author",
    "viewer_review_requested",
    "viewer_review_state",
    "viewer_has_unresolved_threads",
    "needs_attention_reason",
    "is_snoozed",
    "snoozed_at",
    "is_muted",
    "muted_at",
    "is_pinned",
    "added_by",
  ]

  if (legacyColumns.some((name) => columnNames.has(name))) {
    // notes arrived after the original schema, so guarantee it exists before
    // the copy reads it; last_seen_at has been present since the beginning.
    if (!columnNames.has("notes")) {
      await db.execute(`alter table board_items add column notes text`)
    }
    await db.execute(`drop index if exists board_items_column_sort_idx`)
    await db.execute(`drop index if exists board_items_board_pinned_idx`)
    // Drop a leftover scratch table from any interrupted earlier run so the
    // create below cannot collide with it.
    await db.execute(`drop table if exists board_items_migrated`)
    await db.execute(
      `
        create table board_items_migrated (
          id text primary key,
          board_id text not null references boards(id) on delete cascade,
          pull_request_id text not null references pull_requests(id) on delete cascade,
          last_seen_at text,
          notes text,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp,
          archived_at text,
          unique (board_id, pull_request_id)
        )
      `
    )
    await db.execute(
      `
        insert into board_items_migrated (
          id, board_id, pull_request_id, last_seen_at, notes,
          created_at, updated_at, archived_at
        )
        select
          id, board_id, pull_request_id, last_seen_at, notes,
          created_at, updated_at, archived_at
        from board_items
      `
    )
    await db.execute(`drop table board_items`)
    await db.execute(`alter table board_items_migrated rename to board_items`)
  }

  // The lanes table only ever existed for the Kanban; nothing references it
  // once board_items no longer carries a column_id.
  await db.execute(`drop table if exists board_columns`)
}

async function syncBeforeRead(
  db: SqlDatabase,
  options: { githubSearchQuery?: string; force?: boolean } = {}
): Promise<SyncBeforeReadResult> {
  const credentials = await loadLocalGithubCredentials(db)
  if (!credentials) {
    return { didSync: false, hasCredentials: false }
  }

  const fingerprint = JSON.stringify({
    credentials: localGithubSettingsFingerprint(credentials),
    githubSearchQuery: options.githubSearchQuery ?? "",
  })
  if (!options.force) {
    const freshSuccess = await loadFreshSyncSuccess(db, fingerprint, {
      hasSearchQuery: Boolean(options.githubSearchQuery),
    })
    if (freshSuccess) {
      return {
        scope: freshSuccess.scope,
        didSync: false,
        hasCredentials: true,
      }
    }

    // After a failure, background triggers (refocus, intervals) re-throw
    // the remembered error instead of hammering GitHub; the next real
    // attempt happens after the cooldown or on a manual sync.
    const lastFailure = lastFailedSyncByFingerprint.get(fingerprint)
    if (
      lastFailure &&
      Date.now() - lastFailure.failedAtMs < githubSyncFailureCooldownMs
    ) {
      throw lastFailure.error
    }
  }

  const existingSyncPromise = syncPromiseByFingerprint.get(fingerprint)
  if (existingSyncPromise) {
    return existingSyncPromise
  }

  const syncPromise = syncLocalGithubData(db, credentials, options, fingerprint)
  syncPromiseByFingerprint.set(fingerprint, syncPromise)
  const cleanupSyncPromise = () => {
    if (syncPromiseByFingerprint.get(fingerprint) === syncPromise) {
      syncPromiseByFingerprint.delete(fingerprint)
    }
  }
  syncPromise.then(cleanupSyncPromise, cleanupSyncPromise)

  return syncPromise
}

/**
 * Returns the last successful sync for this fingerprint while it is still
 * within the freshness window. The default-scope success survives app
 * restarts via app_settings, so reopening the desktop window shortly after
 * a sync renders local data without kicking off another GitHub round trip.
 * The persisted success is also how concurrently open app instances learn
 * about each other's syncs, so it is consulted whenever the in-memory
 * entry is stale, not just at startup; otherwise every instance re-syncs
 * on its own interval and they contend for the database write lock.
 */
async function loadFreshSyncSuccess(
  db: SqlDatabase,
  fingerprint: string,
  options: { hasSearchQuery: boolean }
): Promise<SyncSuccess | undefined> {
  const isFresh = (finishedAtMs: number) =>
    Date.now() - finishedAtMs < githubSyncFreshnessMs

  const cached = lastSuccessfulSyncByFingerprint.get(fingerprint)
  if (cached && isFresh(cached.finishedAtMs)) {
    return cached
  }

  const raw =
    (await readAppSetting(db, syncSuccessSettingKey(fingerprint))) ??
    (!options.hasSearchQuery
      ? await readAppSetting(db, lastSyncSuccessSettingsKey)
      : undefined)
  if (!raw) return undefined
  const persisted = JSON.parse(raw) as {
    fingerprint?: unknown
    finishedAt?: unknown
    scope?: unknown
  }
  if (
    persisted.fingerprint !== fingerprint ||
    typeof persisted.finishedAt !== "string"
  ) {
    return undefined
  }
  const finishedAtMs = Date.parse(persisted.finishedAt)
  if (!Number.isFinite(finishedAtMs) || !isFresh(finishedAtMs)) {
    return undefined
  }

  const success: SyncSuccess = {
    finishedAtMs,
    scope: parsePersistedSyncScope(persisted.scope),
  }
  lastSuccessfulSyncByFingerprint.set(fingerprint, success)
  return success
}

async function syncLocalGithubData(
  db: SqlDatabase,
  credentials: LocalGithubCredentials,
  options: { githubSearchQuery?: string },
  fingerprint: string
): Promise<SyncBeforeReadResult> {
  const githubSearchQuery = cleanGithubSearchQuery(options.githubSearchQuery)
  const source = createGithubTokenPullRequestSource({
    token: credentials.token,
    repositories: credentials.repositories,
    apiBaseUrl: credentials.apiBaseUrl,
    closedLookbackDays: getGithubClosedLookbackDays({}),
  })
  const syncRunId = await startLocalSyncRun(db, "desktop-settings")
  const result = {
    scannedPullRequests: 0,
    ingestedPullRequests: 0,
    ingestedReviews: 0,
    ignoredPullRequests: 0,
  }

  try {
    const viewerLogin = credentials.viewerLogin ?? (await source.getViewerLogin())
    const snapshots = await listPullRequestSnapshots(source, {
      searchQuery: githubSearchQuery,
    })
    const snapshotsToIngest = githubSearchQuery
      ? snapshots
      : [
          ...snapshots,
          ...(await listKnownOpenPullRequestSnapshots(db, source, snapshots)),
        ]
    result.scannedPullRequests = snapshotsToIngest.length
    const pullRequestIds: string[] = []
    const now = new Date().toISOString()

    await transaction(db, async () => {
      await upsertLocalProfile(db, {
        githubLogin: viewerLogin,
        displayName: viewerLogin,
        now,
      })
      await ensureDefaultBoard(db, now)

      for (const snapshot of snapshotsToIngest) {
        const upsertResult = await upsertLocalPullRequestSnapshot(db, snapshot, {
          viewerLogin,
        })
        pullRequestIds.push(upsertResult.pullRequestId)
        if (upsertResult.isFreshEnough) {
          result.ingestedPullRequests += 1
          result.ingestedReviews += snapshot.reviews?.length ?? 0
        } else {
          result.ignoredPullRequests += 1
        }
      }

      if (githubSearchQuery) {
        await replaceBoardFilterMembership(db, {
          githubSearchQuery,
          pullRequestIds,
          matchedAt: now,
        })
      }
    })
    await finishLocalSyncRun(db, syncRunId, "succeeded", result)
    const scope = githubSearchQuery ? { pullRequestIds } : undefined
    lastFailedSyncByFingerprint.delete(fingerprint)
    lastSuccessfulSyncByFingerprint.set(fingerprint, {
      finishedAtMs: Date.now(),
      scope,
    })
    const success = {
      fingerprint,
      finishedAt: new Date().toISOString(),
      scope,
    }
    await writeAppSetting(db, syncSuccessSettingKey(fingerprint), success)
    if (!githubSearchQuery) {
      await writeAppSetting(db, lastSyncSuccessSettingsKey, success)
    }
    return { scope, didSync: true, hasCredentials: true }
  } catch (error) {
    await finishLocalSyncRun(db, syncRunId, "failed", result, error)
    lastFailedSyncByFingerprint.set(fingerprint, {
      failedAtMs: Date.now(),
      error,
    })
    throw error
  }
}

async function startLocalSyncRun(
  db: SqlDatabase,
  sourceName: string
): Promise<string> {
  const syncRunId = deterministicUuid(
    `sync-run:${sourceName}:${new Date().toISOString()}:${Math.random()}`
  )
  await transaction(db, async () => {
    await db.execute(
      `
        insert into sync_runs (
          id, source, status, scanned_pull_requests, ingested_pull_requests,
          ingested_reviews, ignored_pull_requests, error, started_at, finished_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        syncRunId,
        sourceName,
        "running",
        0,
        0,
        0,
        0,
        null,
        new Date().toISOString(),
        null,
      ]
    )
  })
  return syncRunId
}

async function finishLocalSyncRun(
  db: SqlDatabase,
  syncRunId: string,
  status: "succeeded" | "failed",
  result: {
    scannedPullRequests: number
    ingestedPullRequests: number
    ingestedReviews: number
    ignoredPullRequests: number
  },
  error?: unknown
): Promise<void> {
  await transaction(db, async () => {
    await db.execute(
      `
        update sync_runs
        set
          status = $1,
          scanned_pull_requests = $2,
          ingested_pull_requests = $3,
          ingested_reviews = $4,
          ignored_pull_requests = $5,
          error = $6,
          finished_at = $7
        where id = $8
      `,
      [
        status,
        result.scannedPullRequests,
        result.ingestedPullRequests,
        result.ingestedReviews,
        result.ignoredPullRequests,
        error instanceof Error ? error.message : error ? String(error) : null,
        new Date().toISOString(),
        syncRunId,
      ]
    )
  })
}

async function upsertLocalPullRequestSnapshot(
  db: SqlDatabase,
  snapshot: GitHubPullRequestSnapshot,
  options: { viewerLogin?: string } = {}
): Promise<{ pullRequestId: string; isFreshEnough: boolean }> {
  const pullRequest = snapshotToPullRequestItem(snapshot)
  const githubNodeId = githubNodeIdFromSnapshot(snapshot)
  const incomingUpdatedAt = pullRequest.updatedAt
  const current = (
    await db.select<
      Array<{
        id: string
        github_updated_at: string | null
        raw_payload_json: string | null
      }>
    >(
      `
        select id, github_updated_at, raw_payload_json
        from pull_requests where github_node_id = $1
      `,
      [githubNodeId]
    )
  )[0]

  if (
    current?.github_updated_at &&
    Date.parse(incomingUpdatedAt) < Date.parse(current.github_updated_at)
  ) {
    return { pullRequestId: current.id, isFreshEnough: false }
  }

  // An identical snapshot means this sync found nothing new for the pull
  // request. Skipping the rewrite keeps steady-state syncs read-only, so
  // the write lock stays free for other windows sharing the database.
  if (current && current.raw_payload_json === JSON.stringify(snapshot)) {
    return { pullRequestId: current.id, isFreshEnough: false }
  }

  const now = new Date().toISOString()
  await upsertLocalProfile(db, {
    githubLogin: options.viewerLogin ?? "viewer",
    displayName: options.viewerLogin ?? "viewer",
    now,
  })
  await ensureDefaultBoard(db, now)
  const storedPullRequestId = await upsertPullRequestItem(db, pullRequest, now, {
    githubNodeId,
    rawPayload: snapshot,
    skipThreads: snapshot.review_threads === undefined,
    reviewComments: reviewCommentsFromSnapshot(snapshot),
    skipReviewComments: snapshot.review_threads === undefined,
    issueComments: snapshot.issue_comments,
    skipIssueComments: snapshot.issue_comments === undefined,
  })
  await storeSnapshotAvatarUrls(db, snapshot, now)
  await ensureDefaultBoardItem(db, storedPullRequestId, now)
  return { pullRequestId: storedPullRequestId, isFreshEnough: true }
}

async function storeSnapshotAvatarUrls(
  db: SqlDatabase,
  snapshot: GitHubPullRequestSnapshot,
  now: string
): Promise<void> {
  const avatarUrlByLogin = new Map<string, string>()
  const collect = (user?: { login?: string; avatar_url?: string }) => {
    if (user?.login && user.avatar_url) {
      avatarUrlByLogin.set(user.login, user.avatar_url)
    }
  }

  collect(snapshot.pull_request.user)
  snapshot.pull_request.assignees?.forEach(collect)
  snapshot.pull_request.requested_reviewers?.forEach(collect)
  snapshot.reviews?.forEach((review) => collect(review.user))

  for (const [login, avatarUrl] of avatarUrlByLogin) {
    await upsertGithubAccount(db, {
      login,
      accountType: "user",
      avatarUrl,
      now,
    })
  }
}

async function getStoredPullRequestIdByGithubNodeId(
  db: SqlDatabase,
  githubNodeId: string
): Promise<string | undefined> {
  return (
    await db.select<Array<{ id: string }>>(
      `select id from pull_requests where github_node_id = $1`,
      [githubNodeId]
    )
  )[0]?.id
}

async function upsertPullRequestItem(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string,
  options: {
    githubNodeId?: string
    rawPayload?: unknown
    /** Keep existing thread rows when the snapshot had no thread data. */
    skipThreads?: boolean
    reviewComments?: ReviewCommentInput[]
    /** Keep existing review comment rows when thread/comment data was unavailable. */
    skipReviewComments?: boolean
    issueComments?: GitHubIssueCommentSnapshot[]
    /** Keep existing issue comment rows when the issue comments fetch was unavailable. */
    skipIssueComments?: boolean
  } = {}
): Promise<string> {
  const [owner = "unknown", repoName = pullRequest.repository] =
    pullRequest.repository.split("/")
  const ownerAccountId = await upsertGithubAccount(db, {
    login: owner,
    accountType: "organization",
    now,
  })
  const authorAccountId = await upsertGithubAccount(db, {
    login: pullRequest.authorId,
    accountType: "user",
    now,
  })
  const repositoryId = deterministicUuid(`repository:${pullRequest.repository}`)

  await db.execute(
    `
      insert into github_repositories (
        id, github_node_id, owner_account_id, full_name, name,
        is_private, html_url, raw_payload_json, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict(full_name)
      do update set
        owner_account_id = excluded.owner_account_id,
        name = excluded.name,
        html_url = excluded.html_url,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = excluded.updated_at
    `,
    [
      repositoryId,
      `repository:${pullRequest.repository}`,
      ownerAccountId,
      pullRequest.repository,
      repoName,
      0,
      `https://github.com/${pullRequest.repository}`,
      JSON.stringify({ full_name: pullRequest.repository }),
      now,
      now,
    ]
  )

  await db.execute(
    `
      insert into tracked_repositories (
        id, profile_id, repository_id, sync_enabled, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict(profile_id, repository_id)
      do update set updated_at = excluded.updated_at
    `,
    [
      deterministicUuid(`tracked-repository:${defaultLocalProfileId}:${repositoryId}`),
      defaultLocalProfileId,
      repositoryId,
      1,
      now,
      now,
    ]
  )

  await db.execute(
    `
      insert into pull_requests (
        id, github_node_id, repository_id, number, title, body, url,
        author_account_id, state, is_draft, mergeable_state, review_decision,
        status_check_summary_json, base_ref, head_ref, latest_commit_sha,
        additions, deletions, changed_files,
        github_created_at, github_updated_at, closed_at, merged_at,
        raw_payload_json, created_at, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
      )
      on conflict(github_node_id)
      do update set
        repository_id = excluded.repository_id,
        title = excluded.title,
        body = excluded.body,
        url = excluded.url,
        author_account_id = excluded.author_account_id,
        state = excluded.state,
        is_draft = excluded.is_draft,
        mergeable_state = excluded.mergeable_state,
        review_decision = excluded.review_decision,
        status_check_summary_json = excluded.status_check_summary_json,
        base_ref = excluded.base_ref,
        head_ref = excluded.head_ref,
        latest_commit_sha = excluded.latest_commit_sha,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        github_created_at = excluded.github_created_at,
        github_updated_at = excluded.github_updated_at,
        closed_at = excluded.closed_at,
        merged_at = excluded.merged_at,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = excluded.updated_at
    `,
    [
      pullRequest.id,
      options.githubNodeId ?? pullRequest.id,
      repositoryId,
      pullRequest.number,
      pullRequest.title,
      pullRequest.description ?? null,
      pullRequest.url,
      authorAccountId,
      // The schema constrains state to open/closed; merged survives the
      // round trip through merged_at.
      pullRequest.state === "merged" ? "closed" : pullRequest.state,
      boolToSqlite(pullRequest.isDraft),
      pullRequest.mergeableState ?? null,
      pullRequest.reviewDecision ?? null,
      JSON.stringify(pullRequest.statusCheckRollup ?? {}),
      pullRequest.baseRef ?? null,
      pullRequest.headRef ?? null,
      pullRequest.latestCommitSha,
      pullRequest.additions ?? null,
      pullRequest.deletions ?? null,
      pullRequest.changedFiles ?? null,
      pullRequest.createdAt,
      pullRequest.updatedAt,
      pullRequest.closedAt ?? null,
      pullRequest.mergedAt ??
        (pullRequest.state === "merged" ? pullRequest.updatedAt : null),
      JSON.stringify(options.rawPayload ?? pullRequest),
      now,
      now,
    ]
  )

  const storedPullRequestId = await getStoredPullRequestIdByGithubNodeId(
    db,
    options.githubNodeId ?? pullRequest.id
  )
  if (!storedPullRequestId) {
    throw new Error("Could not resolve stored pull request after upsert.")
  }

  const storedPullRequest = { ...pullRequest, id: storedPullRequestId }
  await replaceLabels(db, repositoryId, storedPullRequest, now)
  await replaceAssignees(db, storedPullRequest, now)
  await replaceReviewRequests(db, storedPullRequest, now)
  await replaceCheckRuns(db, storedPullRequest, now)
  await replaceReviews(db, storedPullRequest.reviews, storedPullRequest.id, now)
  if (!options.skipThreads) {
    await replaceThreads(db, storedPullRequest.threads, storedPullRequest.id, now)
  }
  if (!options.skipReviewComments) {
    await replaceReviewComments(
      db,
      options.reviewComments ?? [],
      storedPullRequest.id,
      now
    )
  }
  if (!options.skipIssueComments) {
    await replaceIssueComments(
      db,
      options.issueComments ?? [],
      storedPullRequest.id,
      now
    )
  }
  await replaceActivity(db, storedPullRequest.activity, storedPullRequest.id, now)

  return storedPullRequestId
}

async function upsertLocalProfile(
  db: SqlDatabase,
  input: { githubLogin: string; displayName: string; now: string }
): Promise<void> {
  const accountId = await upsertGithubAccount(db, {
    login: input.githubLogin,
    accountType: "user",
    now: input.now,
  })
  await db.execute(
    `
      insert into local_profile (
        id, github_login, github_account_id, display_name, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict(id)
      do update set
        github_login = excluded.github_login,
        github_account_id = excluded.github_account_id,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `,
    [
      defaultLocalProfileId,
      input.githubLogin,
      accountId,
      input.displayName,
      input.now,
      input.now,
    ]
  )
}

async function ensureDefaultBoard(db: SqlDatabase, now: string): Promise<void> {
  await db.execute(
    `
      insert into boards (
        id, profile_id, name, is_default, sort_order, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict(id) do update set updated_at = excluded.updated_at
    `,
    [defaultLocalBoardId, defaultLocalProfileId, "Default", 1, 0, now, now]
  )
}

async function ensureDefaultBoardItem(
  db: SqlDatabase,
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(
    `
      insert into board_items (
        id, board_id, pull_request_id, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5)
      on conflict(board_id, pull_request_id)
      do update set updated_at = excluded.updated_at
    `,
    [
      deterministicUuid(`board-item:${defaultLocalBoardId}:${pullRequestId}`),
      defaultLocalBoardId,
      pullRequestId,
      now,
      now,
    ]
  )
}

async function replaceLabels(
  db: SqlDatabase,
  repositoryId: string,
  pullRequest: PullRequestItem,
  now: string
): Promise<void> {
  await db.execute(`delete from pull_request_labels where pull_request_id = $1`, [
    pullRequest.id,
  ])

  for (const label of pullRequest.labels ?? []) {
    const labelId = deterministicUuid(
      `github-label:${repositoryId}:${label.name.toLowerCase()}`
    )
    await db.execute(
      `
        insert into github_labels (
          id, repository_id, github_node_id, name, color, description,
          raw_payload_json, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict(repository_id, name)
        do update set
          color = excluded.color,
          description = excluded.description,
          raw_payload_json = excluded.raw_payload_json,
          updated_at = excluded.updated_at
      `,
      [
        labelId,
        repositoryId,
        labelId,
        label.name,
        label.color ?? null,
        label.description ?? null,
        JSON.stringify(label),
        now,
        now,
      ]
    )
    await db.execute(
      `
        insert into pull_request_labels (
          id, pull_request_id, label_id, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5)
        on conflict(pull_request_id, label_id)
        do update set updated_at = excluded.updated_at
      `,
      [
        deterministicUuid(`pull-request-label:${pullRequest.id}:${labelId}`),
        pullRequest.id,
        labelId,
        now,
        now,
      ]
    )
  }
}

async function replaceAssignees(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string
): Promise<void> {
  await db.execute(`delete from pull_request_assignees where pull_request_id = $1`, [
    pullRequest.id,
  ])

  for (const assigneeId of pullRequest.assigneeIds ?? []) {
    const accountId = await upsertGithubAccount(db, {
      login: assigneeId,
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into pull_request_assignees (
          id, pull_request_id, account_id, created_at
        )
        values ($1, $2, $3, $4)
        on conflict(pull_request_id, account_id) do nothing
      `,
      [
        deterministicUuid(`pull-request-assignee:${pullRequest.id}:${assigneeId}`),
        pullRequest.id,
        accountId,
        now,
      ]
    )
  }
}

async function replaceReviewRequests(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string
): Promise<void> {
  await db.execute(`delete from pull_request_review_requests where pull_request_id = $1`, [
    pullRequest.id,
  ])

  const requestedAtByReviewer = new Map(
    (pullRequest.reviewRequests ?? []).map((request) => [
      request.reviewerId.toLowerCase(),
      request.requestedAt,
    ])
  )
  for (const reviewerId of pullRequest.requestedReviewerIds) {
    const accountId = await upsertGithubAccount(db, {
      login: reviewerId,
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into pull_request_review_requests (
          id, pull_request_id, reviewer_kind, account_id, requested_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6)
      `,
      [
        deterministicUuid(`review-request:${pullRequest.id}:${reviewerId}`),
        pullRequest.id,
        "user",
        accountId,
        requestedAtByReviewer.get(reviewerId.toLowerCase()) ?? null,
        now,
      ]
    )
  }
}

async function replaceCheckRuns(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string
): Promise<void> {
  await db.execute(
    `delete from pull_request_check_runs where pull_request_id = $1`,
    [pullRequest.id]
  )

  for (const checkRun of pullRequest.checkRuns ?? []) {
    const appSlug = checkRun.appSlug ?? ""
    await db.execute(
      `
        insert into pull_request_check_runs (
          id, pull_request_id, name, app_slug, head_sha, status, conclusion,
          started_at, completed_at, details_url, raw_payload_json,
          created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict(pull_request_id, name, head_sha, app_slug)
        do update set
          status = excluded.status,
          conclusion = excluded.conclusion,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          details_url = excluded.details_url,
          raw_payload_json = excluded.raw_payload_json,
          updated_at = excluded.updated_at
      `,
      [
        deterministicUuid(`check-run:${pullRequest.id}:${checkRun.id}`),
        pullRequest.id,
        checkRun.name,
        appSlug,
        checkRun.headSha,
        checkRun.status,
        checkRun.conclusion ?? null,
        checkRun.startedAt ?? null,
        checkRun.completedAt ?? null,
        checkRun.detailsUrl ?? null,
        JSON.stringify(checkRun),
        now,
        now,
      ]
    )
  }
}

async function replaceReviews(
  db: SqlDatabase,
  reviews: ReviewDecisionEvent[],
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(`delete from review_events where pull_request_id = $1`, [
    pullRequestId,
  ])

  for (const review of reviews) {
    const reviewerAccountId = await upsertGithubAccount(db, {
      login: review.reviewerId,
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into review_events (
          id, pull_request_id, github_node_id, reviewer_account_id, decision,
          commit_sha, body, submitted_at, raw_payload_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        review.id,
        pullRequestId,
        review.id,
        reviewerAccountId,
        review.decision,
        review.commitSha ?? null,
        review.body ?? null,
        review.submittedAt,
        JSON.stringify(review),
      ]
    )
  }
}

async function replaceThreads(
  db: SqlDatabase,
  threads: ReviewThread[],
  pullRequestId: string,
  now: string
): Promise<void> {
  const existingThreadRows = await db.select<Array<{ id: string }>>(
    `select id from review_threads where pull_request_id = $1`,
    [pullRequestId]
  )
  for (const row of existingThreadRows) {
    await db.execute(`delete from review_thread_participants where review_thread_id = $1`, [
      row.id,
    ])
  }
  await db.execute(`delete from review_threads where pull_request_id = $1`, [
    pullRequestId,
  ])

  for (const thread of threads) {
    await db.execute(
      `
        insert into review_threads (
          id, pull_request_id, github_node_id, is_resolved, is_outdated,
          last_actor_login, file_path, line, last_activity_at, raw_payload_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        thread.id,
        pullRequestId,
        thread.id,
        boolToSqlite(thread.isResolved),
        boolToSqlite(thread.isOutdated ?? false),
        thread.lastActorId ?? null,
        thread.filePath ?? null,
        thread.line ?? null,
        thread.lastActivityAt,
        JSON.stringify(thread),
      ]
    )

    for (const participantId of thread.participantIds) {
      const participantAccountId = await upsertGithubAccount(db, {
        login: participantId,
        accountType: "user",
        now,
      })
      await db.execute(
        `
          insert into review_thread_participants (
            id, review_thread_id, account_id, created_at
          )
          values ($1, $2, $3, $4)
        `,
        [
          deterministicUuid(`thread-participant:${thread.id}:${participantId}`),
          thread.id,
          participantAccountId,
          now,
        ]
      )
    }
  }
}

async function replaceReviewComments(
  db: SqlDatabase,
  comments: ReviewCommentInput[],
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(`delete from review_comments where pull_request_id = $1`, [
    pullRequestId,
  ])

  for (const comment of comments) {
    const authorAccountId = await upsertGithubAccount(db, {
      login: comment.authorLogin,
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into review_comments (
          id, review_thread_id, pull_request_id, github_node_id,
          author_account_id, body, file_path, line, created_at_github,
          updated_at_github, raw_payload_json, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        comment.id,
        comment.reviewThreadId ?? null,
        pullRequestId,
        comment.githubNodeId,
        authorAccountId,
        comment.body,
        comment.filePath ?? null,
        comment.line ?? null,
        comment.createdAt,
        comment.updatedAt ?? null,
        JSON.stringify(comment.rawPayload),
        now,
        now,
      ]
    )
  }
}

async function replaceIssueComments(
  db: SqlDatabase,
  comments: GitHubIssueCommentSnapshot[],
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(`delete from issue_comments where pull_request_id = $1`, [
    pullRequestId,
  ])

  for (const comment of comments) {
    const body = comment.body.trim()
    if (!body) continue

    const authorAccountId = await upsertGithubAccount(db, {
      login: comment.author?.login ?? "unknown",
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into issue_comments (
          id, pull_request_id, github_node_id, author_account_id, body,
          created_at_github, updated_at_github, raw_payload_json, created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        deterministicUuid(`issue-comment:${comment.id}`),
        pullRequestId,
        comment.id,
        authorAccountId,
        body,
        comment.created_at,
        comment.updated_at ?? null,
        JSON.stringify(comment),
        now,
        now,
      ]
    )
  }
}

async function replaceActivity(
  db: SqlDatabase,
  events: PullRequestActivity[],
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(`delete from activity_events where pull_request_id = $1`, [
    pullRequestId,
  ])

  for (const event of events) {
    const actorAccountId = await upsertGithubAccount(db, {
      login: event.actorId,
      accountType: "user",
      now,
    })
    await db.execute(
      `
        insert into activity_events (
          id, pull_request_id, event_type, actor_account_id, occurred_at,
          title, body, raw_payload_json, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        event.id,
        pullRequestId,
        event.type,
        actorAccountId,
        event.occurredAt,
        event.title,
        event.body ?? null,
        JSON.stringify(event),
        now,
      ]
    )
  }
}

async function upsertGithubAccount(
  db: SqlDatabase,
  input: {
    login: string
    accountType: "user" | "organization" | "bot"
    now: string
    avatarUrl?: string
  }
): Promise<string> {
  const id = deterministicUuid(`github-account:${input.login}`)
  await db.execute(
    `
      insert into github_accounts (
        id, github_node_id, login, account_type, avatar_url,
        raw_payload_json, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict(login)
      do update set
        avatar_url = coalesce(excluded.avatar_url, github_accounts.avatar_url),
        updated_at = excluded.updated_at
    `,
    [
      id,
      `account:${input.login}`,
      input.login,
      input.accountType,
      input.avatarUrl ?? null,
      JSON.stringify({ login: input.login }),
      input.now,
      input.now,
    ]
  )
  return id
}

async function loadBoardState(db: SqlDatabase): Promise<BoardState> {
  const itemRows = await listBoardItemStateRows(db)
  const localQueueState: BoardState["localQueueState"] = {}

  for (const row of itemRows) {
    localQueueState[row.pull_request_id] = {
      notes: row.notes ?? undefined,
    }
  }

  return { localQueueState }
}

async function loadPullRequests(
  db: SqlDatabase,
  options: { id?: string; ids?: string[] } | string = {}
): Promise<PullRequestItem[]> {
  const input = typeof options === "string" ? { id: options } : options
  const rows = await listPullRequestRows(db, input)
  const pullRequests: PullRequestItem[] = []
  for (const row of rows) {
    pullRequests.push(await toPullRequestItem(db, row))
  }
  return pullRequests
}

async function listPullRequestRows(
  db: SqlDatabase,
  input: { id?: string; ids?: string[] } = {}
): Promise<LocalPullRequestRow[]> {
  const scopedIds = input.id ? undefined : input.ids
  if (scopedIds?.length === 0) {
    return []
  }

  // The default scope keeps recently closed PRs visible so projections can
  // report merges and closes that happened while the viewer was away.
  const closedCutoffIso = new Date(
    Date.now() - closedPullRequestReadLookbackDays * 24 * 60 * 60 * 1000
  ).toISOString()
  const scopeSql = input.id
    ? "pr.id = $1"
    : scopedIds
      ? `pr.id in (${scopedIds.map((_, index) => `$${index + 1}`).join(", ")})`
      : "(pr.state = 'open' or pr.github_updated_at >= $1)"
  const parameters = input.id
    ? [input.id]
    : scopedIds ?? [closedCutoffIso]

  return db.select<LocalPullRequestRow[]>(
    `
      select
        pr.id,
        repo.full_name as repository_full_name,
        pr.number,
        pr.title,
        pr.body,
        pr.url,
        coalesce(author.login, 'unknown') as author_login,
        pr.state,
        pr.is_draft,
        pr.latest_commit_sha,
        pr.additions,
        pr.deletions,
        pr.changed_files,
        pr.github_created_at,
        pr.github_updated_at,
        pr.merged_at,
        pr.status_check_summary_json,
        pr.raw_payload_json
      from pull_requests pr
      join github_repositories repo on repo.id = pr.repository_id
      left join github_accounts author on author.id = pr.author_account_id
      where ${scopeSql}
      order by pr.github_updated_at desc
      limit 250
    `,
    parameters
  )
}

async function toPullRequestItem(
  db: SqlDatabase,
  row: LocalPullRequestRow
): Promise<PullRequestItem> {
  const [reviewRequests, reviews, reviewThreads, activity] = await Promise.all([
    listReviewRequestRows(db, row.id),
    listReviewEventRows(db, row.id),
    listReviewThreadRows(db, row.id),
    listActivityEventRows(db, row.id),
  ])
  const [issueComments, reviewComments] = await Promise.all([
    listIssueCommentRows(db, row.id),
    listReviewCommentRows(db, row.id),
  ])
  const [labels, assignees] = await Promise.all([
    listPullRequestLabelRows(db, row.id),
    listPullRequestAssigneeRows(db, row.id),
  ])
  const participants = await listReviewThreadParticipantRows(
    db,
    reviewThreads.map((thread) => thread.id)
  )
  const participantIdsByThreadId = new Map<string, string[]>()
  for (const participant of participants) {
    participantIdsByThreadId.set(participant.review_thread_id, [
      ...(participantIdsByThreadId.get(participant.review_thread_id) ?? []),
      participant.login,
    ])
  }

  return {
    id: row.id,
    repository: row.repository_full_name,
    number: row.number,
    title: row.title,
    description: row.body ?? descriptionFromRawPayload(row.raw_payload_json),
    url: row.url,
    authorId: row.author_login,
    state: row.merged_at ? "merged" : (row.state as PullRequestItem["state"]),
    isDraft: Boolean(row.is_draft),
    createdAt: row.github_created_at ?? new Date().toISOString(),
    updatedAt: row.github_updated_at ?? new Date().toISOString(),
    latestCommitSha: row.latest_commit_sha ?? "",
    labels: labels.map((label) => ({
      name: label.name,
      color: label.color ?? undefined,
      description: label.description ?? undefined,
    })),
    assigneeIds: assignees.map((assignee) => assignee.login),
    additions: row.additions ?? undefined,
    deletions: row.deletions ?? undefined,
    changedFiles: row.changed_files ?? undefined,
    statusCheckRollup: parseStatusCheckRollup(row.status_check_summary_json),
    requestedReviewerIds: reviewRequests.flatMap((request) =>
      request.login ? [request.login] : []
    ),
    reviewRequests: reviewRequests.flatMap((request) =>
      request.login && request.requested_at
        ? [{ reviewerId: request.login, requestedAt: request.requested_at }]
        : []
    ),
    comments: [
      ...issueComments.map((comment) => ({
        id: comment.id,
        authorId: comment.author_login,
        createdAt: comment.created_at_github,
      })),
      ...reviewComments.map((comment) => ({
        id: comment.id,
        authorId: comment.author_login,
        createdAt: comment.created_at_github,
      })),
    ] satisfies PullRequestComment[],
    reviews: reviews.map((review) => ({
      id: review.id,
      reviewerId: review.reviewer_login,
      decision: review.decision,
      submittedAt: review.submitted_at,
      commitSha: review.commit_sha ?? undefined,
      body: review.body ?? undefined,
    })),
    threads: reviewThreads.map((thread) => ({
      id: thread.id,
      isResolved: Boolean(thread.is_resolved),
      isOutdated: Boolean(thread.is_outdated),
      participantIds: participantIdsByThreadId.get(thread.id) ?? [],
      lastActorId: thread.last_actor_login ?? undefined,
      filePath: thread.file_path ?? undefined,
      line: thread.line ?? undefined,
      lastActivityAt: thread.last_activity_at,
    })),
    activity: activity.map((event) => ({
      id: event.id,
      type: event.event_type,
      actorId: event.actor_login,
      occurredAt: event.occurred_at,
      title: event.title,
      body: event.body ?? undefined,
      url: event.url ?? undefined,
      diffUrl: event.diff_url ?? undefined,
    })),
  }
}

async function listPullRequestLabelRows(
  db: SqlDatabase,
  pullRequestId: string
): Promise<LocalPullRequestLabelRow[]> {
  return db.select<LocalPullRequestLabelRow[]>(
    `
      select
        pr_label.pull_request_id,
        label.name,
        label.color,
        label.description
      from pull_request_labels pr_label
      join github_labels label on label.id = pr_label.label_id
      where pr_label.pull_request_id = $1
      order by label.name collate nocase asc
    `,
    [pullRequestId]
  )
}

async function listPullRequestAssigneeRows(
  db: SqlDatabase,
  pullRequestId: string
): Promise<LocalPullRequestAssigneeRow[]> {
  return db.select<LocalPullRequestAssigneeRow[]>(
    `
      select
        assignee.pull_request_id,
        account.login
      from pull_request_assignees assignee
      join github_accounts account on account.id = assignee.account_id
      where assignee.pull_request_id = $1
      order by account.login collate nocase asc
    `,
    [pullRequestId]
  )
}

async function listReviewRequestRows(db: SqlDatabase, pullRequestId: string) {
  return db.select<
    Array<{
      pull_request_id: string
      reviewer_kind: "user" | "team"
      login: string | null
      team_slug: string | null
      requested_at: string | null
    }>
  >(
    `
      select
        rr.pull_request_id,
        rr.reviewer_kind,
        account.login,
        team.slug as team_slug,
        rr.requested_at
      from pull_request_review_requests rr
      left join github_accounts account on account.id = rr.account_id
      left join github_teams team on team.id = rr.team_id
      where rr.pull_request_id = $1
      order by rr.created_at asc
    `,
    [pullRequestId]
  )
}

async function listReviewEventRows(db: SqlDatabase, pullRequestId: string) {
  return db.select<
    Array<{
      id: string
      pull_request_id: string
      reviewer_login: string
      decision: ReviewDecisionEvent["decision"]
      commit_sha: string | null
      body: string | null
      submitted_at: string
    }>
  >(
    `
      select
        review.id,
        review.pull_request_id,
        coalesce(account.login, 'unknown') as reviewer_login,
        review.decision,
        review.commit_sha,
        review.body,
        review.submitted_at
      from review_events review
      left join github_accounts account on account.id = review.reviewer_account_id
      where review.pull_request_id = $1
      order by review.submitted_at desc
    `,
    [pullRequestId]
  )
}

async function listReviewThreadRows(db: SqlDatabase, pullRequestId: string) {
  return db.select<
    Array<{
      id: string
      pull_request_id: string
      is_resolved: number
      is_outdated: number
      last_actor_login: string | null
      file_path: string | null
      line: number | null
      last_activity_at: string
    }>
  >(
    `
      select id, pull_request_id, is_resolved, is_outdated, last_actor_login,
        file_path, line, last_activity_at
      from review_threads
      where pull_request_id = $1
      order by last_activity_at desc
    `,
    [pullRequestId]
  )
}

async function listReviewThreadParticipantRows(
  db: SqlDatabase,
  threadIds: string[]
) {
  if (threadIds.length === 0) return []
  const placeholders = threadIds.map((_, index) => `$${index + 1}`).join(", ")
  return db.select<
    Array<{
      review_thread_id: string
      login: string
    }>
  >(
    `
      select
        participant.review_thread_id,
        account.login
      from review_thread_participants participant
      join github_accounts account on account.id = participant.account_id
      where participant.review_thread_id in (${placeholders})
      order by participant.id asc
    `,
    threadIds
  )
}

async function listReviewCommentRows(
  db: SqlDatabase,
  pullRequestId: string
): Promise<LocalReviewCommentRow[]> {
  return db.select<LocalReviewCommentRow[]>(
    `
      select
        comment.id,
        comment.review_thread_id,
        comment.pull_request_id,
        coalesce(author.login, 'unknown') as author_login,
        comment.body,
        comment.file_path,
        comment.line,
        comment.created_at_github,
        comment.updated_at_github,
        json_extract(comment.raw_payload_json, '$.url') as url
      from review_comments comment
      left join github_accounts author on author.id = comment.author_account_id
      where comment.pull_request_id = $1
      order by comment.created_at_github asc
    `,
    [pullRequestId]
  )
}

async function listIssueCommentRows(
  db: SqlDatabase,
  pullRequestId: string
): Promise<LocalIssueCommentRow[]> {
  return db.select<LocalIssueCommentRow[]>(
    `
      select
        comment.id,
        comment.pull_request_id,
        coalesce(author.login, 'unknown') as author_login,
        comment.body,
        comment.created_at_github,
        comment.updated_at_github,
        json_extract(comment.raw_payload_json, '$.url') as url
      from issue_comments comment
      left join github_accounts author on author.id = comment.author_account_id
      where comment.pull_request_id = $1
      order by comment.created_at_github asc
    `,
    [pullRequestId]
  )
}

async function listActivityEventRows(db: SqlDatabase, pullRequestId: string) {
  return db.select<
    Array<{
      id: string
      pull_request_id: string
      event_type: PullRequestActivity["type"]
      actor_login: string
      occurred_at: string
      title: string
      body: string | null
      url: string | null
      diff_url: string | null
    }>
  >(
    `
      select
        activity.id,
        activity.pull_request_id,
        activity.event_type,
        coalesce(actor.login, 'unknown') as actor_login,
        activity.occurred_at,
        activity.title,
        activity.body,
        json_extract(activity.raw_payload_json, '$.url') as url,
        json_extract(activity.raw_payload_json, '$.diffUrl') as diff_url
      from activity_events activity
      left join github_accounts actor on actor.id = activity.actor_account_id
      where activity.pull_request_id = $1
      order by activity.occurred_at asc
    `,
    [pullRequestId]
  )
}

async function listBoardItemStateRows(
  db: SqlDatabase
): Promise<LocalBoardItemStateRow[]> {
  return db.select<LocalBoardItemStateRow[]>(
    `
      select pull_request_id, last_seen_at, notes
      from board_items
      where board_id = $1 and archived_at is null
      order by pull_request_id asc
    `,
    [defaultLocalBoardId]
  )
}

async function loadBoardFilterMembershipPullRequestIds(
  db: SqlDatabase,
  githubSearchQuery: string
): Promise<string[]> {
  const fingerprint = await boardFilterMembershipFingerprint(db, githubSearchQuery)
  const rows = await db.select<Array<{ pull_request_id: string }>>(
    `
      select pull_request_id
      from board_filter_memberships
      where board_id = $1 and fingerprint = $2
      order by sort_order asc, pull_request_id asc
    `,
    [defaultLocalBoardId, fingerprint]
  )
  return rows.map((row) => row.pull_request_id)
}

async function replaceBoardFilterMembership(
  db: SqlDatabase,
  input: {
    githubSearchQuery: string
    pullRequestIds: string[]
    matchedAt: string
  }
): Promise<void> {
  const fingerprint = await boardFilterMembershipFingerprint(
    db,
    input.githubSearchQuery
  )

  await db.execute(
    `
      delete from board_filter_memberships
      where board_id = $1 and fingerprint = $2
    `,
    [defaultLocalBoardId, fingerprint]
  )

  for (const [index, pullRequestId] of input.pullRequestIds.entries()) {
    await db.execute(
      `
        insert into board_filter_memberships (
          id, board_id, fingerprint, github_search_query, pull_request_id,
          sort_order, matched_at, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        deterministicUuid(
          `board-filter-membership:${fingerprint}:${pullRequestId}`
        ),
        defaultLocalBoardId,
        fingerprint,
        input.githubSearchQuery,
        pullRequestId,
        index,
        input.matchedAt,
        input.matchedAt,
        input.matchedAt,
      ]
    )
  }
}

async function boardFilterMembershipFingerprint(
  db: SqlDatabase,
  githubSearchQuery: string
): Promise<string> {
  return JSON.stringify({
    settings: localGithubSettingsScopeFingerprint(await readLocalGithubSettings(db)),
    githubSearchQuery: cleanGithubSearchQuery(githubSearchQuery) ?? "",
  })
}

async function loadLastSeen(
  db: SqlDatabase
): Promise<Record<string, string | undefined>> {
  return Object.fromEntries(
    (await listBoardItemStateRows(db)).map((row) => [
      row.pull_request_id,
      row.last_seen_at ?? undefined,
    ])
  )
}

async function readLocalGithubSettings(
  db: SqlDatabase
): Promise<LocalGithubSettings> {
  const raw = await readAppSetting(db, githubSettingsKey)
  if (!raw) return { repositories: [], tokenConfigured: false }

  const parsed = JSON.parse(raw) as {
    repositories?: unknown
    viewerLogin?: unknown
    apiBaseUrl?: unknown
    tokenConfigured?: unknown
    tokenStorage?: unknown
  }
  const isStrongholdToken =
    parsed.tokenStorage === desktopTokenStorage && parsed.tokenConfigured === true

  return {
    repositories: Array.isArray(parsed.repositories)
      ? parseGithubRepositories(parsed.repositories.join(","))
      : [],
    viewerLogin:
      typeof parsed.viewerLogin === "string" ? parsed.viewerLogin : undefined,
    apiBaseUrl:
      typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : undefined,
    tokenConfigured: isStrongholdToken,
    tokenStorage: isStrongholdToken ? desktopTokenStorage : undefined,
  }
}

async function readOnboardingState(db: SqlDatabase): Promise<OnboardingState> {
  const raw = await readAppSetting(db, onboardingSettingsKey)
  if (!raw) return { version: 1 }

  const parsed = JSON.parse(raw) as {
    completedAt?: unknown
    introSkippedAt?: unknown
    version?: unknown
  }

  return {
    version: normalizeOnboardingVersion(parsed.version),
    completedAt:
      typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
    introSkippedAt:
      typeof parsed.introSkippedAt === "string"
        ? parsed.introSkippedAt
        : undefined,
  }
}

/**
 * Resolves the viewer identity for classification reads. The explicit
 * Settings username wins, then the login the last sync resolved from the
 * token (stored on local_profile). Without this fallback a blank username
 * field made reads classify against the literal "viewer", so no real pull
 * request could ever match the user.
 */
async function resolveViewerLogin(db: SqlDatabase): Promise<string> {
  const settings = await readLocalGithubSettings(db)
  if (settings.viewerLogin) {
    return settings.viewerLogin
  }

  const rows = await db.select<Array<{ github_login: string | null }>>(
    `select github_login from local_profile where id = $1`,
    [defaultLocalProfileId]
  )
  return rows[0]?.github_login ?? "viewer"
}

async function readAppSetting(
  db: SqlDatabase,
  key: string
): Promise<string | undefined> {
  return (
    await db.select<Array<{ value_json: string }>>(
      `select value_json from app_settings where key = $1`,
      [key]
    )
  )[0]?.value_json
}

async function writeLocalGithubSettings(
  db: SqlDatabase,
  settings: LocalGithubSettings
): Promise<void> {
  await writeAppSetting(db, githubSettingsKey, settings)
}

async function writeAppSetting(
  db: SqlDatabase,
  key: string,
  value: unknown
): Promise<void> {
  await db.execute(
    `
      insert into app_settings (key, value_json, updated_at)
      values ($1, $2, $3)
      on conflict(key)
      do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
    [key, JSON.stringify(value), new Date().toISOString()]
  )
}

async function loadLocalGithubCredentials(
  db: SqlDatabase
): Promise<LocalGithubCredentials | undefined> {
  const settings = await readLocalGithubSettings(db)
  if (settings.repositories.length === 0) {
    return undefined
  }
  const token = await readToken(db)
  if (!token) {
    throw new Error(
      "GitHub settings are saved, but the Stronghold token is missing. Re-enter your GitHub token in Settings."
    )
  }

  return { ...settings, token }
}

async function readToken(db: SqlDatabase): Promise<string | undefined> {
  if (cachedToken) {
    return cachedToken
  }

  tokenReadPromise ??= readTokenFromStronghold(db)
  return tokenReadPromise
}

async function readTokenFromStronghold(
  db: SqlDatabase
): Promise<string | undefined> {
  const { store } = await getStrongholdSession(db)
  const tokenBytes = await store.get(githubTokenStoreKey)
  cachedToken = tokenBytes ? bytesToString(tokenBytes) : undefined
  if (!cachedToken) {
    tokenReadPromise = undefined
  }

  return cachedToken
}

async function writeToken(db: SqlDatabase, token: string): Promise<void> {
  const { stronghold, store } = await getStrongholdSession(db)
  await store.insert(githubTokenStoreKey, stringToBytes(token))
  await stronghold.save()
  cachedToken = token
  tokenReadPromise = Promise.resolve(token)
}

async function readLocalAiSettings(db: SqlDatabase): Promise<StoredAiSettings> {
  const raw = await readAppSetting(db, aiSettingsKey)
  if (!raw) return normalizeStoredAiSettings(undefined)

  try {
    return normalizeStoredAiSettings(JSON.parse(raw))
  } catch {
    return normalizeStoredAiSettings(undefined)
  }
}

async function readAiApiKey(db: SqlDatabase): Promise<string | undefined> {
  if (cachedAiApiKey) {
    return cachedAiApiKey
  }

  aiApiKeyReadPromise ??= readAiApiKeyFromStronghold(db)
  return aiApiKeyReadPromise
}

async function readAiApiKeyFromStronghold(
  db: SqlDatabase
): Promise<string | undefined> {
  const { store } = await getStrongholdSession(db)
  const keyBytes = await store.get(openRouterApiKeyStoreKey)
  cachedAiApiKey = keyBytes ? bytesToString(keyBytes) : undefined
  if (!cachedAiApiKey) {
    aiApiKeyReadPromise = undefined
  }

  return cachedAiApiKey
}

async function writeAiApiKey(db: SqlDatabase, apiKey: string): Promise<void> {
  const { stronghold, store } = await getStrongholdSession(db)
  await store.insert(openRouterApiKeyStoreKey, stringToBytes(apiKey))
  await stronghold.save()
  cachedAiApiKey = apiKey
  aiApiKeyReadPromise = Promise.resolve(apiKey)
}

type AiSummaryKind =
  | "pr-brief"
  | "ai-dashboard"

interface AiSummaryRow {
  cache_key: string
  model: string
  content_json: string
  generated_at: string
}

interface ActiveAiConfig {
  provider: AiProvider
  model: string
  apiKey?: string
}

async function requireActiveAiConfig(db: SqlDatabase): Promise<ActiveAiConfig> {
  const settings = await readLocalAiSettings(db)
  if (!settings.enabled) {
    throw new Error("AI mode is not enabled. Turn it on in Settings.")
  }

  if (settings.provider === "codex") {
    return { provider: "codex", model: settings.model }
  }

  const apiKey = settings.apiKeyConfigured ? await readAiApiKey(db) : undefined
  if (!apiKey) {
    throw new Error("AI mode is not enabled. Turn it on in Settings.")
  }

  return { provider: "openrouter", model: settings.model, apiKey }
}

/** Routes a structured completion to the configured provider. */
async function runStructuredAiCompletion<T>(
  config: ActiveAiConfig,
  request: {
    system: string
    user: string
    schemaName: string
    schema: Record<string, unknown>
  }
): Promise<T> {
  if (config.provider === "codex") {
    return requestCodexStructuredCompletion<T>({
      model: config.model,
      ...request,
      run: runCodexCommand,
    })
  }

  return requestStructuredCompletion<T>({
    apiKey: config.apiKey ?? "",
    model: config.model,
    ...request,
  })
}

/** Routes a free-form chat completion to the configured provider. */
async function runChatAiCompletion(
  config: ActiveAiConfig,
  request: { system: string; messages: ChatTurn[] }
): Promise<string> {
  if (config.provider === "codex") {
    return requestCodexChat({
      model: config.model,
      system: request.system,
      messages: request.messages,
      run: runCodexCommand,
    })
  }

  return requestOpenRouterChat({
    apiKey: config.apiKey ?? "",
    model: config.model,
    system: request.system,
    messages: request.messages,
  })
}

async function runCodexCommand(args: string[]): Promise<CodexExecResult> {
  const output = await Command.create("codex", args).execute()
  return {
    code: output.code ?? -1,
    stdout: output.stdout,
    stderr: output.stderr,
  }
}

async function readAiSummaryRow(
  db: SqlDatabase,
  pullRequestId: string,
  kind: AiSummaryKind
): Promise<AiSummaryRow | undefined> {
  return (
    await db.select<AiSummaryRow[]>(
      `
        select cache_key, model, content_json, generated_at
        from ai_summaries
        where pull_request_id = $1 and kind = $2
      `,
      [pullRequestId, kind]
    )
  )[0]
}

async function writeAiSummaryRow(
  db: SqlDatabase,
  pullRequestId: string,
  kind: AiSummaryKind,
  input: {
    cacheKey: string
    model: string
    contentJson: string
    generatedAt: string
  }
): Promise<void> {
  await db.execute(
    `
      insert into ai_summaries
        (pull_request_id, kind, cache_key, model, content_json, generated_at)
      values ($1, $2, $3, $4, $5, $6)
      on conflict(pull_request_id, kind)
      do update set
        cache_key = excluded.cache_key,
        model = excluded.model,
        content_json = excluded.content_json,
        generated_at = excluded.generated_at
    `,
    [
      pullRequestId,
      kind,
      input.cacheKey,
      input.model,
      input.contentJson,
      input.generatedAt,
    ]
  )
}

/**
 * Builds the board-scoped view-model item for one pull request, the source of
 * the turn facts (whose move, waiting age, reason, checks, reviewers) the PR
 * brief is grounded in.
 */
async function loadPullRequestView(
  db: SqlDatabase,
  pullRequestId: string
): Promise<{ item: ReviewQueueItemView; viewerLogin: string }> {
  const pullRequests = await loadPullRequests(db, pullRequestId)
  if (pullRequests.length === 0) {
    throw new Error("Pull request not found.")
  }

  const viewerLogin = await resolveViewerLogin(db)
  const actors = buildActors(
    pullRequests,
    [viewerLogin],
    await loadAvatarUrlsByLogin(db)
  )
  const viewer = ensureActor(actors, viewerLogin)
  const inbox = buildReviewerInbox({
    viewer,
    actors,
    pullRequests,
    now: new Date().toISOString(),
    lastSeenAtByPullRequestId: await loadLastSeen(db),
  })
  const classified = inbox.items[0] ?? inbox.inactiveItems?.[0]
  if (!classified) {
    throw new Error("Pull request not found.")
  }

  const item = toReviewQueueItemView(
    classified,
    new Map(actors.map((actor) => [actor.id, actor])),
    viewer.id,
    await readAttentionThresholds(db)
  )
  return { item, viewerLogin }
}

function isItemStalled(item: ReviewQueueItemView): boolean {
  return item.workflowState === "stale" || item.waitingUrgency === "overdue"
}

async function readAttentionThresholds(
  db: SqlDatabase
): Promise<AttentionThresholds> {
  const raw = await readAppSetting(db, attentionSettingsKey)
  if (!raw) return { ...defaultAttentionThresholds }
  try {
    return normalizeAttentionSettings(JSON.parse(raw))
  } catch {
    return { ...defaultAttentionThresholds }
  }
}

/**
 * Local thread facts for the PR brief, plus the allowed file list the
 * normalizer uses to drop any thread note whose path is not a real thread.
 */
async function loadPrBriefThreads(
  db: SqlDatabase,
  pullRequestId: string
): Promise<{ threads: PrBriefThreadInput[]; allowedFiles: string[] }> {
  const threadRows = await listReviewThreadRows(db, pullRequestId)
  if (threadRows.length === 0) {
    return { threads: [], allowedFiles: [] }
  }

  const viewerLogin = await resolveViewerLogin(db)
  const participants = await listReviewThreadParticipantRows(
    db,
    threadRows.map((thread) => thread.id)
  )
  const participantsByThreadId = new Map<string, string[]>()
  for (const participant of participants) {
    const logins = participantsByThreadId.get(participant.review_thread_id) ?? []
    logins.push(participant.login)
    participantsByThreadId.set(participant.review_thread_id, logins)
  }

  const threads: PrBriefThreadInput[] = threadRows.map((thread) => {
    const isResolved = thread.is_resolved === 1
    return {
      filePath: thread.file_path ?? undefined,
      line: thread.line ?? undefined,
      status: isResolved ? "resolved" : "unresolved",
      awaitingYourReply:
        !isResolved && thread.last_actor_login !== viewerLogin,
      isOutdated: thread.is_outdated === 1,
      lastActorLogin: thread.last_actor_login ?? undefined,
      participants: participantsByThreadId.get(thread.id) ?? [],
    }
  })

  return {
    threads,
    allowedFiles: threadRows.flatMap((thread) =>
      thread.file_path
        ? [threadLocationKey(thread.file_path, thread.line ?? undefined)]
        : []
    ),
  }
}

/**
 * The activity (with comment bodies) that landed after the board item's
 * last-seen marker — what the brief restates under "since you last looked".
 */
async function loadPrBriefNewEvents(
  db: SqlDatabase,
  pullRequestId: string
): Promise<PrBriefEventInput[]> {
  const lastSeenAt = (
    await db.select<Array<{ last_seen_at: string | null }>>(
      `
        select last_seen_at from board_items
        where board_id = $1 and pull_request_id = $2
      `,
      [defaultLocalBoardId, pullRequestId]
    )
  )[0]?.last_seen_at

  const events = (await listActivityEventRows(db, pullRequestId)).filter(
    (event) => !lastSeenAt || event.occurred_at > lastSeenAt
  )
  const comments = (await listDiscussionComments(db, pullRequestId)).filter(
    (comment) => !lastSeenAt || comment.occurredAt > lastSeenAt
  )

  return [
    ...events.map((event) => ({
      type: event.event_type,
      actor: event.actor_login,
      title: event.title,
      body: event.body ?? undefined,
      occurredAt: event.occurred_at,
    })),
    ...comments.map((comment) => ({
      type: comment.source,
      actor: comment.actor,
      title: comment.filePath
        ? `Commented on ${comment.filePath}${comment.line ? `:${comment.line}` : ""}`
        : "Commented on the pull request",
      body: comment.body,
      occurredAt: comment.occurredAt,
    })),
  ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

async function listDiscussionComments(
  db: SqlDatabase,
  pullRequestId: string
): Promise<DiscussionCommentInput[]> {
  const [reviewComments, issueComments, reviewEvents] = await Promise.all([
    listReviewCommentRows(db, pullRequestId),
    listIssueCommentRows(db, pullRequestId),
    listReviewEventRows(db, pullRequestId),
  ])

  return [
    ...issueComments.map((comment) => ({
      actor: comment.author_login,
      body: comment.body,
      occurredAt: comment.created_at_github,
      source: "issue_comment" as const,
    })),
    ...reviewComments.map((comment) => ({
      actor: comment.author_login,
      body: comment.body,
      occurredAt: comment.created_at_github,
      source: "review_comment" as const,
      filePath: comment.file_path ?? undefined,
      line: comment.line ?? undefined,
    })),
    ...reviewEvents.flatMap((review) =>
      review.body
        ? [
            {
              actor: review.reviewer_login,
              body: review.body,
              occurredAt: review.submitted_at,
              source: "review" as const,
            },
          ]
        : []
    ),
  ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

async function enrichAiDashboardInputWithComments(
  db: SqlDatabase,
  input: AiDashboardInput
): Promise<AiDashboardInput> {
  return {
    ...input,
    items: await Promise.all(
      input.items.map(async (item) => ({
        ...item,
        discussionExcerpts: (await listDiscussionComments(db, item.id)).slice(-5),
      }))
    ),
  }
}

/**
 * The brief goes stale when the head commit moves, when GitHub records new
 * activity (its updated_at advances on comments and reviews), or when the
 * reviewer marks the pull request caught up. Computed from local rows only so
 * the read path never needs a GitHub round trip; the cached content still
 * renders until the reviewer regenerates.
 */
async function prBriefCacheKey(
  db: SqlDatabase,
  pullRequestId: string,
  model: string
): Promise<string> {
  const row = (await listPullRequestRows(db, { id: pullRequestId }))[0]
  const head = row?.latest_commit_sha ?? ""
  const updatedAt = row?.github_updated_at ?? ""
  const lastSeenAt =
    (
      await db.select<Array<{ last_seen_at: string | null }>>(
        `
          select last_seen_at from board_items
          where board_id = $1 and pull_request_id = $2
        `,
        [defaultLocalBoardId, pullRequestId]
      )
    )[0]?.last_seen_at ?? ""
  return hashContent(`pr-brief\n${model}\n${head}\n${updatedAt}\n${lastSeenAt}`)
}

async function getStrongholdSession(
  db: SqlDatabase
): Promise<StrongholdSession> {
  strongholdSessionPromise ??= createStrongholdSession(db)
  return strongholdSessionPromise
}

async function createStrongholdSession(
  db: SqlDatabase
): Promise<StrongholdSession> {
  const password = await readOrCreateStrongholdPassword(db)
  const vaultPath = await join(await appDataDir(), strongholdFilename)
  const stronghold = await Stronghold.load(vaultPath, password)
  let client

  try {
    client = await stronghold.loadClient(strongholdClientName)
  } catch {
    client = await stronghold.createClient(strongholdClientName)
    await stronghold.save()
  }

  return { stronghold, store: client.getStore() }
}

async function readOrCreateStrongholdPassword(
  db: SqlDatabase
): Promise<string> {
  const raw = await readAppSetting(db, strongholdPasswordSettingsKey)
  if (raw) {
    const parsed = JSON.parse(raw) as { value?: unknown }
    if (typeof parsed.value === "string" && parsed.value.length > 0) {
      return parsed.value
    }
  }

  const password = randomSecret()
  await writeAppSetting(db, strongholdPasswordSettingsKey, { value: password })
  return password
}

function randomSecret(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function stringToBytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value))
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

function normalizeOnboardingVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 1
}

function parseStatusCheckRollup(
  json: string | null
): PullRequestItem["statusCheckRollup"] {
  if (!json) return undefined

  try {
    const parsed = JSON.parse(json) as { state?: unknown; totalCount?: unknown }
    if (
      parsed.state !== "success" &&
      parsed.state !== "failure" &&
      parsed.state !== "pending"
    ) {
      return undefined
    }

    return {
      state: parsed.state,
      totalCount:
        typeof parsed.totalCount === "number" ? parsed.totalCount : undefined,
    }
  } catch {
    return undefined
  }
}

async function listKnownOpenPullRequestSnapshots(
  db: SqlDatabase,
  source: ReturnType<typeof createGithubTokenPullRequestSource>,
  listedSnapshots: GitHubPullRequestSnapshot[]
): Promise<GitHubPullRequestSnapshot[]> {
  const getPullRequest = source.getPullRequest
  if (!getPullRequest) return []

  const listedPullRequestKeys = new Set(
    listedSnapshots
      .map((snapshot) =>
        pullRequestKey(snapshot.repository.full_name, snapshot.pull_request.number)
      )
      .filter((key) => key !== undefined)
  )
  const rows = await db.select<Array<{ repository: string; number: number }>>(
    `
      select repo.full_name as repository, pr.number
      from pull_requests pr
      join github_repositories repo on repo.id = pr.repository_id
      where pr.state = 'open'
      order by pr.github_updated_at desc
    `
  )
  // listKnownOpenPullRequests returns distinct open pull requests, so pre-
  // filtering the listed set once is equivalent to skipping inside the loop.
  const rowsToRefresh = rows.filter((row) => {
    const key = pullRequestKey(row.repository, row.number)
    return key !== undefined && !listedPullRequestKeys.has(key)
  })

  const refreshed = await mapConcurrent(rowsToRefresh, 8, (row) =>
    getPullRequest({
      repository: row.repository,
      number: row.number,
    }).catch((error: unknown) => {
      if (isTransientGithubDetailRefreshError(error)) {
        console.warn(
          `Skipping refresh for known pull request ${row.repository}#${row.number}:`,
          error
        )
        return undefined
      }

      throw error
    })
  )

  return refreshed.filter(
    (snapshot): snapshot is GitHubPullRequestSnapshot => snapshot !== undefined
  )
}

function isTransientGithubDetailRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed out|timeout|aborted|failed to fetch|load failed|network/i.test(
    message
  )
}

async function listPullRequestSnapshots(
  source: ReturnType<typeof createGithubTokenPullRequestSource>,
  options: { searchQuery?: string }
): Promise<GitHubPullRequestSnapshot[]> {
  if (source.listPullRequests) {
    return source.listPullRequests(options)
  }

  if (source.listOpenPullRequests) {
    return source.listOpenPullRequests(options)
  }

  throw new Error("GitHub pull request source does not provide a list method.")
}

function snapshotToPullRequestItem(
  snapshot: GitHubPullRequestSnapshot
): PullRequestItem {
  const pullRequest = snapshot.pull_request
  const repository = snapshot.repository.full_name
  const number = pullRequest.number ?? 0
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString()
  const reviews = compactReviewsForInbox(snapshot.reviews ?? [])
  const url = pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`

  return {
    id: livePullRequestId(repository, number),
    repository,
    number,
    title: pullRequest.title ?? "Untitled pull request",
    description: cleanPullRequestDescription(pullRequest.body),
    url,
    authorId: pullRequest.user?.login ?? "unknown",
    state: pullRequest.merged
      ? "merged"
      : normalizeSnapshotPullRequestState(pullRequest.state),
    isDraft: pullRequest.draft ?? false,
    createdAt: pullRequest.created_at ?? updatedAt,
    updatedAt,
    closedAt: pullRequest.closed_at ?? undefined,
    mergedAt:
      pullRequest.merged_at ??
      (pullRequest.merged ? updatedAt : undefined),
    baseRef: pullRequest.base?.ref ?? undefined,
    headRef: pullRequest.head?.ref ?? undefined,
    mergeableState: pullRequest.mergeable_state ?? undefined,
    reviewDecision: snapshot.review_decision ?? undefined,
    latestCommitSha: pullRequest.head?.sha ?? "",
    labels: (pullRequest.labels ?? [])
      .map(mapSnapshotLabel)
      .filter((label): label is PullRequestLabel => Boolean(label)),
    assigneeIds: (pullRequest.assignees ?? [])
      .map((assignee) => assignee.login)
      .filter((login): login is string => Boolean(login)),
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    statusCheckRollup: snapshot.status_check_rollup
      ? {
          state: snapshot.status_check_rollup.state,
          totalCount: snapshot.status_check_rollup.total_count,
        }
      : undefined,
    checkRuns: (snapshot.check_runs ?? []).map((checkRun) => ({
      id: checkRun.id,
      name: checkRun.name,
      appSlug: checkRun.app_slug,
      headSha: checkRun.head_sha,
      status: checkRun.status,
      conclusion: checkRun.conclusion,
      startedAt: checkRun.started_at,
      completedAt: checkRun.completed_at,
      detailsUrl: checkRun.details_url,
    })),
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviewRequests: mapSnapshotReviewRequests(snapshot),
    reviews: reviews.flatMap(mapSnapshotReview),
    threads: (snapshot.review_threads ?? []).map((thread) =>
      mapSnapshotReviewThread(thread, updatedAt)
    ),
    activity: buildSnapshotActivity({ ...snapshot, reviews }),
  }
}

/**
 * Pair each currently requested reviewer with the time GitHub recorded the
 * request, taken from the timeline. Reviewers without a known request time
 * (older data, or a timeline fetch that failed) are omitted so the classifier
 * treats the outstanding request as unanswered rather than inventing a time.
 */
function mapSnapshotReviewRequests(
  snapshot: GitHubPullRequestSnapshot
): ReviewRequestEvent[] {
  const requestedAtByLogin = new Map(
    (snapshot.review_requests ?? []).map((request) => [
      request.reviewer_login.toLowerCase(),
      request.requested_at,
    ])
  )
  return (snapshot.pull_request.requested_reviewers ?? []).flatMap((reviewer) => {
    const login = reviewer.login
    if (!login) return []
    const requestedAt = requestedAtByLogin.get(login.toLowerCase())
    return requestedAt ? [{ reviewerId: login, requestedAt }] : []
  })
}

function mapSnapshotLabel(
  label: NonNullable<GitHubPullRequestSnapshot["pull_request"]["labels"]>[number]
): PullRequestLabel | undefined {
  if (!label.name) return undefined

  return {
    name: label.name,
    color: normalizeGithubLabelColor(label.color),
    description: label.description ?? undefined,
  }
}

function normalizeGithubLabelColor(value: string | null | undefined): string | undefined {
  const color = value?.replace(/^#/, "").trim()
  return color && /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined
}

function mapSnapshotReviewThread(
  thread: GitHubReviewThreadSnapshot,
  fallbackTimestamp: string
): ReviewThread {
  const comments = (thread.comments ?? [])
    .slice()
    .sort(
      (a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "")
    )
  const lastComment = comments[comments.length - 1]
  const participantIds = [
    ...new Set(
      comments
        .map((comment) => comment.author?.login)
        .filter((login): login is string => Boolean(login))
    ),
  ]

  return {
    id: thread.id,
    isResolved: thread.is_resolved ?? false,
    isOutdated: thread.is_outdated ?? false,
    participantIds,
    lastActorId: lastComment?.author?.login,
    filePath: thread.path ?? undefined,
    line: thread.line ?? undefined,
    lastActivityAt: lastComment?.created_at ?? fallbackTimestamp,
  }
}

function reviewCommentsFromSnapshot(
  snapshot: GitHubPullRequestSnapshot
): ReviewCommentInput[] {
  const comments: ReviewCommentInput[] = []

  for (const thread of snapshot.review_threads ?? []) {
    for (const comment of thread.comments ?? []) {
      const githubNodeId = comment.id
      const body = comment.body?.trim()
      const createdAt = comment.created_at
      if (!githubNodeId || !body || !createdAt) continue

      comments.push({
        id: deterministicUuid(`review-comment:${githubNodeId}`),
        reviewThreadId: thread.id,
        githubNodeId,
        authorLogin: comment.author?.login ?? "unknown",
        body,
        filePath: comment.path ?? thread.path ?? undefined,
        line: comment.line ?? thread.line ?? undefined,
        createdAt,
        updatedAt: comment.updated_at,
        url: comment.url,
        rawPayload: { ...comment, review_thread_id: thread.id },
      })
    }
  }

  return comments
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[],
  avatarUrlByLogin: Map<string, string>
): Actor[] {
  const logins = new Set<string>(extraLogins)
  for (const pullRequest of pullRequests) {
    logins.add(pullRequest.authorId)
    pullRequest.assigneeIds?.forEach((login) => logins.add(login))
    pullRequest.requestedReviewerIds.forEach((login) => logins.add(login))
    pullRequest.reviews.forEach((review) => logins.add(review.reviewerId))
    pullRequest.threads.forEach((thread) =>
      thread.participantIds.forEach((login) => logins.add(login))
    )
    pullRequest.activity.forEach((event) => logins.add(event.actorId))
  }

  return Array.from(logins).map((login) => ({
    id: login,
    login,
    avatarUrl: avatarUrlByLogin.get(login),
  }))
}

async function loadAvatarUrlsByLogin(
  db: SqlDatabase
): Promise<Map<string, string>> {
  const rows = await db.select<Array<{ login: string; avatar_url: string }>>(
    `select login, avatar_url from github_accounts where avatar_url is not null`
  )
  return new Map(rows.map((row) => [row.login, row.avatar_url]))
}

function ensureActor(actors: Actor[], id: string): Actor {
  const actor = actors.find((candidate) => candidate.id === id)
  if (actor) return actor
  const created = { id, login: id }
  actors.push(created)
  return created
}

function compactReviewsForInbox(
  reviews: GitHubReviewSnapshot[]
): GitHubReviewSnapshot[] {
  const latestByReviewer = new Map<string, GitHubReviewSnapshot>()
  const newestReviews = reviews
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.submitted_at ?? "") - Date.parse(a.submitted_at ?? "")
    )

  for (const review of newestReviews) {
    const reviewerLogin = review.user?.login
    if (!reviewerLogin || latestByReviewer.has(reviewerLogin)) continue
    latestByReviewer.set(reviewerLogin, review)
  }

  return uniqueReviewsById([...newestReviews.slice(0, 20), ...latestByReviewer.values()])
    .sort(
      (a, b) =>
        Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? "")
    )
}

function uniqueReviewsById(
  reviews: GitHubReviewSnapshot[]
): GitHubReviewSnapshot[] {
  const seenIds = new Set<string>()
  const uniqueReviews: GitHubReviewSnapshot[] = []
  for (const review of reviews) {
    const id = review.node_id ?? String(review.id)
    if (seenIds.has(id)) continue
    seenIds.add(id)
    uniqueReviews.push(review)
  }
  return uniqueReviews
}

function mapSnapshotReview(review: GitHubReviewSnapshot): ReviewDecisionEvent[] {
  const reviewerId = review.user?.login
  if (!reviewerId) return []
  return [
    {
      id: review.node_id ?? String(review.id),
      reviewerId,
      decision: mapSnapshotReviewDecision(review.state),
      submittedAt: review.submitted_at ?? new Date().toISOString(),
      commitSha: review.commit_id,
      body: review.body ?? undefined,
    },
  ]
}

function mapSnapshotReviewDecision(
  state: string | undefined
): ReviewDecisionEvent["decision"] {
  if (state?.toLowerCase() === "approved") return "approved"
  if (state?.toLowerCase() === "changes_requested") return "changes_requested"
  return "commented"
}

function buildSnapshotActivity(
  snapshot: GitHubPullRequestSnapshot
): PullRequestActivity[] {
  const pullRequest = snapshot.pull_request
  const repository = snapshot.repository.full_name
  const number = pullRequest.number ?? 0
  const updatedAt = pullRequest.updated_at ?? new Date().toISOString()
  const authorLogin = pullRequest.user?.login ?? "unknown"
  const pullRequestUrl =
    pullRequest.html_url ?? `https://github.com/${repository}/pull/${number}`
  const activity: PullRequestActivity[] = [
    {
      id: `${livePullRequestId(repository, number)}:updated`,
      type: "pull_request",
      actorId: authorLogin,
      occurredAt: updatedAt,
      title: `${authorLogin} updated this pull request`,
      url: pullRequestUrl,
      diffUrl: `${pullRequestUrl}/files`,
    },
  ]

  for (const reviewer of pullRequest.requested_reviewers ?? []) {
    if (!reviewer.login) continue
    activity.push({
      id: `${livePullRequestId(repository, number)}:review-request:${reviewer.login}`,
      type: "review_request",
      actorId: authorLogin,
      occurredAt: updatedAt,
      title: `${authorLogin} requested review from ${reviewer.login}`,
    })
  }

  for (const review of snapshot.reviews ?? []) {
    if (!review.user?.login) continue
    activity.push({
      id: `${livePullRequestId(repository, number)}:review:${review.node_id ?? review.id}`,
      type: "review",
      actorId: review.user.login,
      occurredAt: review.submitted_at ?? updatedAt,
      title: `${review.user.login} ${snapshotReviewTitle(review.state)}`,
      body: review.body ?? undefined,
    })
  }

  return activity.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
  )
}

function snapshotReviewTitle(state: string | undefined): string {
  if (state?.toLowerCase() === "approved") return "approved this pull request"
  if (state?.toLowerCase() === "changes_requested") return "requested changes"
  return "reviewed this pull request"
}

function normalizeSnapshotPullRequestState(
  state: string | undefined
): PullRequestItem["state"] {
  if (state === "closed") return "closed"
  if (state === "merged") return "merged"
  return "open"
}

function githubNodeIdFromSnapshot(snapshot: GitHubPullRequestSnapshot): string {
  const pullRequest = snapshot.pull_request
  if (pullRequest.node_id) return pullRequest.node_id
  if (typeof pullRequest.id === "number" && pullRequest.id > 0) {
    return String(pullRequest.id)
  }
  return `pull-request:${snapshot.repository.full_name}:${pullRequest.number ?? 0}`
}

function descriptionFromRawPayload(rawPayloadJson: string): string | undefined {
  try {
    const rawPayload = JSON.parse(rawPayloadJson) as { description?: unknown }
    return typeof rawPayload.description === "string"
      ? rawPayload.description
      : undefined
  } catch {
    return undefined
  }
}

function cleanPullRequestDescription(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function backupTimestamp(now = new Date()): string {
  return now.toISOString().replaceAll(/\D/g, "").slice(0, 17)
}

function cleanOptionalText(value: string | undefined): string | null {
  if (!value?.trim()) return null
  return value.replace(/\r\n?/g, "\n")
}

function localGithubSettingsFingerprint(credentials: LocalGithubCredentials): string {
  return JSON.stringify({
    ...localGithubSettingsScopeFingerprint(credentials),
    tokenLength: credentials.token.length,
  })
}

function localGithubSettingsScopeFingerprint(
  settings: {
    repositories: string[]
    viewerLogin?: string
    apiBaseUrl?: string
  }
): {
  repositories: string[]
  viewerLogin?: string
  apiBaseUrl?: string
} {
  return {
    repositories: settings.repositories,
    viewerLogin: settings.viewerLogin,
    apiBaseUrl: settings.apiBaseUrl,
  }
}

function cleanGithubSearchQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function syncSuccessSettingKey(fingerprint: string): string {
  return `${lastSyncSuccessSettingsKey}:${deterministicUuid(fingerprint)}`
}

function parsePersistedSyncScope(value: unknown): SyncScope | undefined {
  if (!value || typeof value !== "object") return undefined
  const pullRequestIds = (value as { pullRequestIds?: unknown }).pullRequestIds
  if (!Array.isArray(pullRequestIds)) return undefined
  return {
    pullRequestIds: pullRequestIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0
    ),
  }
}

function pullRequestKey(
  repository: string | undefined,
  number: number | undefined
): string | undefined {
  return repository && number !== undefined ? `${repository}#${number}` : undefined
}

function livePullRequestId(repository: string, number: number): string {
  return `github:${repository.replace("/", "~")}:${number}`
}

function deterministicUuid(input: string): string {
  let hash = 0xcbf29ce484222325n
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  const hex = hash.toString(16).padStart(32, "0").slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-")
}

function boolToSqlite(value: boolean): number {
  return value ? 1 : 0
}
