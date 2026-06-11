import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecisionEvent,
  ReviewThread,
} from "@pr-tracker/core"
import {
  sampleAvatarUrlsByLogin,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests,
} from "@pr-tracker/core"
import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  parseGithubRepositories,
  type GitHubPullRequestSnapshot,
  type GitHubReviewSnapshot,
  type GitHubReviewThreadSnapshot,
} from "@pr-tracker/github"
import { buildReviewerInbox } from "@pr-tracker/reviewer-workflow"
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
  GithubSettingsStatus,
  OnboardingState,
  PullRequestDetailResponse,
  InsightsVisit,
  SaveAiSettingsInput,
  SaveGithubSettingsInput,
  SqliteBackupResult,
  SyncGithubDataResult,
  SyncStatus,
} from "@/api"
import {
  normalizeAiModel,
  normalizeStoredAiSettings,
  type StoredAiSettings,
} from "@/ai/ai-settings"
import { hashContent } from "@/ai/content-hash"
import { requestStructuredCompletion } from "@/ai/openrouter"
import {
  buildCatchUpDigestPrompt,
  buildPrSummaryPrompt,
  catchUpDigestSchema,
  catchUpDigestSchemaName,
  normalizeCatchUpDigestContent,
  normalizePrSummaryContent,
  prSummarySchema,
  prSummarySchemaName,
  type CatchUpDigestContent,
  type PrSummaryContent,
} from "@/ai/summaries"
import { defaultAttentionThresholds } from "@/reviewer/view-model"
import { localDesktopSchemaSql } from "../../../../packages/db/src/local-schema"
import { createQueuedTransaction } from "./sqlite-transaction"

const databaseUrl = "sqlite:pr-tracker.sqlite"
const defaultLocalProfileId = "local"
const defaultLocalBoardId = "default-board"
const githubSettingsKey = "github-settings"
const onboardingSettingsKey = "onboarding"
const attentionSettingsKey = "attention_thresholds"
const insightsVisitSettingsKey = "insights-visit"
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

interface LocalBoardItemStateRow {
  pull_request_id: string
  column_id: string | null
  sort_order: number
  last_seen_at: string | null
  notes: string | null
  is_snoozed: number
  snoozed_at: string | null
  is_muted: number
  muted_at: string | null
  is_pinned: number
}

interface LocalBoardColumnRow {
  id: string
  name: string
  sort_order: number
  width_px: number
}

interface StrongholdSession {
  stronghold: Stronghold
  store: StrongholdStore
}

let databasePromise: Promise<SqlDatabase> | undefined
let insightsVisitAnchor: { previousVisitAt?: string } | undefined
let lastSuccessfulSyncFingerprint: string | undefined
let lastSuccessfulSyncScope: { pullRequestIds?: string[] } | undefined
const transaction = createQueuedTransaction<SqlDatabase>()
const syncPromiseByFingerprint = new Map<
  string,
  Promise<{ pullRequestIds?: string[] } | undefined>
>()

export async function getDesktopReviewerInbox(input?: {
  githubSearchQuery?: string
}) {
  const db = await getDatabase()
  // GitHub-scoped searches need a sync to resolve which PRs match. The
  // default inbox reads local SQLite only; syncDesktopGithubData refreshes
  // it in the background.
  const readScope = input?.githubSearchQuery
    ? await syncBeforeRead(db, input)
    : undefined
  const pullRequests = await loadPullRequests(db, {
    ids: input?.githubSearchQuery ? readScope?.pullRequestIds ?? [] : undefined,
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
  if (input?.force) {
    lastSuccessfulSyncFingerprint = undefined
    lastSuccessfulSyncScope = undefined
  }

  const credentials = await loadLocalGithubCredentials(db)
  if (!credentials) {
    if (await isLocalDatabaseEmpty(db)) {
      await seedLocalSampleData(db)
    }
    return { status: "no-credentials" }
  }

  await syncBeforeRead(db, { githubSearchQuery: input?.githubSearchQuery })
  return { status: "synced" }
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

export async function saveDesktopBoardState(
  state: BoardState
): Promise<BoardState> {
  const db = await getDatabase()
  const bucketIds = new Set(state.buckets.map((bucket) => bucket.id))
  const fallbackBucketId = state.buckets[0]?.id ?? "inbox"
  const knownPullRequestIds = new Set(
    (await listPullRequestRows(db)).map((row) => row.id)
  )
  const itemByPullRequestId = new Map<
    string,
    {
      pullRequestId: string
      columnId: string
      sortOrder: number
      snoozed?: boolean
      snoozedAt?: string
      muted?: boolean
      mutedAt?: string
      pinned?: boolean
      notes?: string
    }
  >()

  for (const [bucketId, itemIds] of Object.entries(state.userBucketItemOrder)) {
    if (!bucketIds.has(bucketId)) continue

    itemIds.forEach((pullRequestId, index) => {
      if (!knownPullRequestIds.has(pullRequestId)) return
      itemByPullRequestId.set(pullRequestId, {
        pullRequestId,
        columnId: bucketId,
        sortOrder: index,
      })
    })
  }

  for (const [pullRequestId, itemState] of Object.entries(state.localQueueState)) {
    if (!itemState || !knownPullRequestIds.has(pullRequestId)) continue

    const current = itemByPullRequestId.get(pullRequestId)
    const columnId =
      itemState.bucketId && bucketIds.has(itemState.bucketId)
        ? itemState.bucketId
        : current?.columnId ?? fallbackBucketId

    itemByPullRequestId.set(pullRequestId, {
      pullRequestId,
      columnId,
      sortOrder: current?.sortOrder ?? itemByPullRequestId.size,
      snoozed: itemState.snoozed,
      snoozedAt: itemState.snoozed ? itemState.snoozedAt : undefined,
      muted: itemState.muted,
      mutedAt: itemState.muted ? itemState.mutedAt : undefined,
      pinned: itemState.pinned,
      notes: itemState.notes,
    })
  }

  await transaction(db, async () => {
    const now = new Date().toISOString()
    const activeColumnIds = new Set(state.buckets.map((bucket) => bucket.id))

    for (const [index, bucket] of state.buckets.entries()) {
      await db.execute(
        `
          insert into board_columns (
            id, board_id, name, sort_order, width_px, created_at, updated_at, archived_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, null)
          on conflict(id)
          do update set
            name = excluded.name,
            sort_order = excluded.sort_order,
            width_px = excluded.width_px,
            archived_at = null,
            updated_at = excluded.updated_at
        `,
        [
          bucket.id,
          defaultLocalBoardId,
          bucket.label,
          index,
          state.bucketColumnWidths[bucket.id] ?? 232,
          now,
          now,
        ]
      )
    }

    for (const column of await listBoardColumnRows(db)) {
      if (activeColumnIds.has(column.id)) continue
      await db.execute(
        `
          update board_columns
          set archived_at = $1, updated_at = $2
          where id = $3 and board_id = $4
        `,
        [now, now, column.id, defaultLocalBoardId]
      )
    }

    for (const item of itemByPullRequestId.values()) {
      await db.execute(
        `
          insert into board_items (
            id, board_id, pull_request_id, column_id, sort_order,
            notes, is_snoozed, snoozed_at, is_muted, muted_at, is_pinned,
            created_at, updated_at, archived_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null)
          on conflict(board_id, pull_request_id)
          do update set
            column_id = excluded.column_id,
            sort_order = excluded.sort_order,
            notes = excluded.notes,
            is_snoozed = excluded.is_snoozed,
            snoozed_at = excluded.snoozed_at,
            is_muted = excluded.is_muted,
            muted_at = excluded.muted_at,
            is_pinned = excluded.is_pinned,
            archived_at = null,
            updated_at = excluded.updated_at
        `,
        [
          deterministicUuid(`board-item:${defaultLocalBoardId}:${item.pullRequestId}`),
          defaultLocalBoardId,
          item.pullRequestId,
          item.columnId,
          item.sortOrder,
          cleanOptionalText(item.notes),
          boolToSqlite(Boolean(item.snoozed)),
          item.snoozed ? item.snoozedAt ?? now : null,
          boolToSqlite(Boolean(item.muted)),
          item.muted ? item.mutedAt ?? now : null,
          boolToSqlite(Boolean(item.pinned)),
          now,
          now,
        ]
      )
    }
  })

  return loadBoardState(db)
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
  lastSuccessfulSyncFingerprint = undefined

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

  return { enabled: stored.enabled, model: stored.model, apiKeyConfigured }
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

  if (input.enabled && !apiKeyConfigured) {
    throw new Error("An OpenRouter API key is required to enable AI mode.")
  }

  const settings: StoredAiSettings = {
    enabled: input.enabled,
    model: normalizeAiModel(input.model),
    apiKeyConfigured,
  }
  await writeAppSetting(db, aiSettingsKey, settings)
  return settings
}

export async function getDesktopAiPrSummary(
  pullRequestId: string
): Promise<AiGenerated<PrSummaryContent> | undefined> {
  const db = await getDatabase()
  const row = await readAiSummaryRow(db, pullRequestId, "pr-summary")
  if (!row) {
    return undefined
  }

  const settings = await readLocalAiSettings(db)
  const expectedKey = await prSummaryCacheKey(db, pullRequestId, settings.model)

  return {
    content: normalizePrSummaryContent(JSON.parse(row.content_json)),
    generatedAt: row.generated_at,
    model: row.model,
    isStale: expectedKey !== row.cache_key,
  }
}

export async function generateDesktopAiPrSummary(
  pullRequestId: string
): Promise<AiGenerated<PrSummaryContent>> {
  const db = await getDatabase()
  const config = await requireActiveAiConfig(db)
  const pullRequest = (await listPullRequestRows(db, { id: pullRequestId }))[0]
  if (!pullRequest) {
    throw new Error("Pull request not found.")
  }

  const credentials = await loadLocalGithubCredentials(db)
  if (!credentials) {
    throw new Error(
      "Generating a summary needs GitHub access to fetch the diff. Configure GitHub in Settings first."
    )
  }

  const source = createGithubTokenPullRequestSource(credentials)
  const files = await source.listPullRequestChangedFiles({
    repository: pullRequest.repository_full_name,
    number: pullRequest.number,
  })
  if (!files) {
    throw new Error(
      "Could not fetch the diff for this pull request from GitHub."
    )
  }

  const prompt = buildPrSummaryPrompt({
    repository: pullRequest.repository_full_name,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? undefined,
    authorLogin: pullRequest.author_login,
    state: pullRequest.state,
    isDraft: pullRequest.is_draft === 1,
    additions: pullRequest.additions ?? undefined,
    deletions: pullRequest.deletions ?? undefined,
    changedFiles: pullRequest.changed_files ?? undefined,
    files,
  })
  const content = normalizePrSummaryContent(
    await requestStructuredCompletion<PrSummaryContent>({
      apiKey: config.apiKey,
      model: config.model,
      system: prompt.system,
      user: prompt.user,
      schemaName: prSummarySchemaName,
      schema: prSummarySchema,
    })
  )

  const generatedAt = new Date().toISOString()
  await writeAiSummaryRow(db, pullRequestId, "pr-summary", {
    cacheKey: await prSummaryCacheKey(db, pullRequestId, config.model),
    model: config.model,
    contentJson: JSON.stringify(content),
    generatedAt,
  })

  return { content, generatedAt, model: config.model, isStale: false }
}

export async function getDesktopAiCatchUpDigest(
  pullRequestId: string
): Promise<AiGenerated<CatchUpDigestContent> | undefined> {
  const db = await getDatabase()
  const row = await readAiSummaryRow(db, pullRequestId, "catch-up-digest")
  if (!row) {
    return undefined
  }

  const settings = await readLocalAiSettings(db)
  const prompt = await buildCatchUpDigestPromptForPullRequest(db, pullRequestId)
  const expectedKey = await hashContent(
    `catch-up-digest\n${settings.model}\n${prompt?.user ?? ""}`
  )

  return {
    content: normalizeCatchUpDigestContent(JSON.parse(row.content_json)),
    generatedAt: row.generated_at,
    model: row.model,
    isStale: expectedKey !== row.cache_key,
  }
}

export async function generateDesktopAiCatchUpDigest(
  pullRequestId: string
): Promise<AiGenerated<CatchUpDigestContent>> {
  const db = await getDatabase()
  const config = await requireActiveAiConfig(db)
  const prompt = await buildCatchUpDigestPromptForPullRequest(db, pullRequestId)
  if (!prompt) {
    throw new Error("Nothing new has happened since you last caught up.")
  }

  const content = normalizeCatchUpDigestContent(
    await requestStructuredCompletion<CatchUpDigestContent>({
      apiKey: config.apiKey,
      model: config.model,
      system: prompt.system,
      user: prompt.user,
      schemaName: catchUpDigestSchemaName,
      schema: catchUpDigestSchema,
    })
  )

  const generatedAt = new Date().toISOString()
  await writeAiSummaryRow(db, pullRequestId, "catch-up-digest", {
    cacheKey: await hashContent(
      `catch-up-digest\n${config.model}\n${prompt.user}`
    ),
    model: config.model,
    contentJson: JSON.stringify(content),
    generatedAt,
  })

  return { content, generatedAt, model: config.model, isStale: false }
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
  await db.execute("pragma busy_timeout = 10000")
  await db.execute("pragma journal_mode = wal")
  await db.execute("pragma foreign_keys = on")
  for (const statement of splitSqlStatements(localDesktopSchemaSql)) {
    await db.execute(statement)
  }
  await ensureBoardItemNotesColumn(db)
  await ensureBoardItemAttentionTimestampColumns(db)
  await ensureReviewThreadLedgerColumns(db)
  await ensurePullRequestSizeColumns(db)
  return db
}

async function syncBeforeRead(
  db: SqlDatabase,
  options: { githubSearchQuery?: string } = {}
): Promise<{ pullRequestIds?: string[] } | undefined> {
  const credentials = await loadLocalGithubCredentials(db)
  if (!credentials) {
    if (await isLocalDatabaseEmpty(db)) {
      await seedLocalSampleData(db)
    }
    return
  }

  const fingerprint = JSON.stringify({
    credentials: localGithubSettingsFingerprint(credentials),
    githubSearchQuery: options.githubSearchQuery ?? "",
  })
  if (lastSuccessfulSyncFingerprint === fingerprint) {
    return lastSuccessfulSyncScope
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

async function syncLocalGithubData(
  db: SqlDatabase,
  credentials: LocalGithubCredentials,
  options: { githubSearchQuery?: string },
  fingerprint: string
): Promise<{ pullRequestIds?: string[] } | undefined> {
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
      searchQuery: options.githubSearchQuery,
    })
    const snapshotsToIngest = options.githubSearchQuery
      ? snapshots
      : [
          ...snapshots,
          ...(await listKnownOpenPullRequestSnapshots(db, source, snapshots)),
        ]
    result.scannedPullRequests = snapshotsToIngest.length
    const pullRequestIds: string[] = []

    await transaction(db, async () => {
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
    })
    await finishLocalSyncRun(db, syncRunId, "succeeded", result)
    lastSuccessfulSyncScope = options.githubSearchQuery
      ? { pullRequestIds }
      : undefined
    lastSuccessfulSyncFingerprint = fingerprint
  } catch (error) {
    await finishLocalSyncRun(db, syncRunId, "failed", result, error)
    throw error
  }

  return lastSuccessfulSyncScope
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

async function seedLocalSampleData(db: SqlDatabase): Promise<void> {
  const now = new Date().toISOString()
  await transaction(db, async () => {
    await upsertLocalProfile(db, {
      githubLogin: "viewer",
      displayName: "you",
      now,
    })
    await ensureDefaultBoard(db, now)

    for (const pullRequest of samplePullRequests) {
      const storedPullRequestId = await upsertPullRequestItem(db, pullRequest, now)
      await ensureDefaultBoardItem(db, storedPullRequestId, now)
    }

    for (const [login, avatarUrl] of Object.entries(sampleAvatarUrlsByLogin)) {
      await upsertGithubAccount(db, {
        login,
        accountType: "user",
        avatarUrl,
        now,
      })
    }

    for (const [pullRequestId, lastSeenAt] of Object.entries(
      sampleLastSeenAtByPullRequestId
    )) {
      await db.execute(
        `
          update board_items
          set last_seen_at = $1, updated_at = $2
          where board_id = $3 and pull_request_id = $4
        `,
        [lastSeenAt ?? null, now, defaultLocalBoardId, pullRequestId]
      )
    }
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
    await db.select<Array<{ id: string; github_updated_at: string | null }>>(
      `select id, github_updated_at from pull_requests where github_node_id = $1`,
      [githubNodeId]
    )
  )[0]

  if (
    current?.github_updated_at &&
    Date.parse(incomingUpdatedAt) < Date.parse(current.github_updated_at)
  ) {
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
        author_account_id, state, is_draft, latest_commit_sha,
        additions, deletions, changed_files,
        github_created_at, github_updated_at, merged_at,
        status_check_summary_json, raw_payload_json, created_at, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21
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
        latest_commit_sha = excluded.latest_commit_sha,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        github_created_at = excluded.github_created_at,
        github_updated_at = excluded.github_updated_at,
        merged_at = excluded.merged_at,
        status_check_summary_json = excluded.status_check_summary_json,
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
      pullRequest.latestCommitSha,
      pullRequest.additions ?? null,
      pullRequest.deletions ?? null,
      pullRequest.changedFiles ?? null,
      pullRequest.createdAt,
      pullRequest.updatedAt,
      pullRequest.state === "merged" ? pullRequest.updatedAt : null,
      JSON.stringify(pullRequest.statusCheckRollup ?? {}),
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
  await replaceReviewRequests(db, storedPullRequest, now)
  await replaceReviews(db, storedPullRequest.reviews, storedPullRequest.id, now)
  if (!options.skipThreads) {
    await replaceThreads(db, storedPullRequest.threads, storedPullRequest.id, now)
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

  const columns = [
    ["inbox", "Inbox", 0],
    ["reviewing", "Reviewing", 1],
    ["waiting", "Waiting", 2],
    ["later", "Later", 3],
    ["done", "Done", 4],
  ] as const

  for (const [id, name, sortOrder] of columns) {
    await db.execute(
      `
        insert into board_columns (
          id, board_id, name, sort_order, width_px, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict(id)
        do update set
          name = excluded.name,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `,
      [id, defaultLocalBoardId, name, sortOrder, 232, now, now]
    )
  }
}

async function ensureDefaultBoardItem(
  db: SqlDatabase,
  pullRequestId: string,
  now: string
): Promise<void> {
  await db.execute(
    `
      insert into board_items (
        id, board_id, pull_request_id, column_id, sort_order, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict(board_id, pull_request_id)
      do update set updated_at = excluded.updated_at
    `,
    [
      deterministicUuid(`board-item:${defaultLocalBoardId}:${pullRequestId}`),
      defaultLocalBoardId,
      pullRequestId,
      "inbox",
      0,
      now,
      now,
    ]
  )
}

async function replaceReviewRequests(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string
): Promise<void> {
  await db.execute(`delete from pull_request_review_requests where pull_request_id = $1`, [
    pullRequest.id,
  ])

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
        null,
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
  const columns = await listBoardColumnRows(db)
  const itemRows = await listBoardItemStateRows(db)
  const localQueueState: BoardState["localQueueState"] = {}
  const userBucketItemOrder = Object.fromEntries(
    columns.map((column) => [column.id, [] as string[]])
  )
  const bucketColumnWidths = Object.fromEntries(
    columns.map((column) => [column.id, column.width_px])
  )

  for (const row of itemRows) {
    if (row.column_id) {
      userBucketItemOrder[row.column_id] ??= []
      userBucketItemOrder[row.column_id]?.push(row.pull_request_id)
    }

    localQueueState[row.pull_request_id] = {
      bucketId: row.column_id ?? undefined,
      snoozed: row.is_snoozed ? true : undefined,
      snoozedAt: row.is_snoozed ? row.snoozed_at ?? undefined : undefined,
      muted: row.is_muted ? true : undefined,
      mutedAt: row.is_muted ? row.muted_at ?? undefined : undefined,
      pinned: row.is_pinned ? true : undefined,
      notes: row.notes ?? undefined,
    }
  }

  return {
    buckets: columns.map((column) => ({ id: column.id, label: column.name })),
    localQueueState,
    userBucketItemOrder,
    bucketColumnWidths,
  }
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
    additions: row.additions ?? undefined,
    deletions: row.deletions ?? undefined,
    changedFiles: row.changed_files ?? undefined,
    statusCheckRollup: parseStatusCheckRollup(row.status_check_summary_json),
    requestedReviewerIds: reviewRequests.flatMap((request) =>
      request.login ? [request.login] : []
    ),
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

async function listReviewRequestRows(db: SqlDatabase, pullRequestId: string) {
  return db.select<
    Array<{
      pull_request_id: string
      reviewer_kind: "user" | "team"
      login: string | null
      team_slug: string | null
    }>
  >(
    `
      select
        rr.pull_request_id,
        rr.reviewer_kind,
        account.login,
        team.slug as team_slug
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
      select
        pull_request_id,
        column_id,
        sort_order,
        last_seen_at,
        notes,
        is_snoozed,
        snoozed_at,
        is_muted,
        muted_at,
        is_pinned
      from board_items
      where board_id = $1 and archived_at is null
      order by column_id asc, sort_order asc, pull_request_id asc
    `,
    [defaultLocalBoardId]
  )
}

async function listBoardColumnRows(db: SqlDatabase): Promise<LocalBoardColumnRow[]> {
  return db.select<LocalBoardColumnRow[]>(
    `
      select id, name, sort_order, width_px
      from board_columns
      where board_id = $1 and archived_at is null
      order by sort_order asc, created_at asc
    `,
    [defaultLocalBoardId]
  )
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

type AiSummaryKind = "pr-summary" | "catch-up-digest" | "thread-state"

interface AiSummaryRow {
  cache_key: string
  model: string
  content_json: string
  generated_at: string
}

async function requireActiveAiConfig(
  db: SqlDatabase
): Promise<{ model: string; apiKey: string }> {
  const settings = await readLocalAiSettings(db)
  const apiKey = settings.apiKeyConfigured ? await readAiApiKey(db) : undefined
  if (!settings.enabled || !apiKey) {
    throw new Error("AI mode is not enabled. Turn it on in Settings.")
  }

  return { model: settings.model, apiKey }
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
 * The digest covers the deterministic delta the page already computes: all
 * cached activity after the board item's last-seen marker. Returns
 * undefined when there is nothing new to digest.
 */
async function buildCatchUpDigestPromptForPullRequest(
  db: SqlDatabase,
  pullRequestId: string
): Promise<{ system: string; user: string } | undefined> {
  const pullRequest = (await listPullRequestRows(db, { id: pullRequestId }))[0]
  if (!pullRequest) {
    throw new Error("Pull request not found.")
  }

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
  if (events.length === 0) {
    return undefined
  }

  return buildCatchUpDigestPrompt({
    repository: pullRequest.repository_full_name,
    number: pullRequest.number,
    title: pullRequest.title,
    lastSeenAt: lastSeenAt ?? undefined,
    events: events.map((event) => ({
      type: event.event_type,
      actor: event.actor_login,
      title: event.title,
      body: event.body ?? undefined,
      occurredAt: event.occurred_at,
    })),
  })
}

/**
 * The summary is regenerated only when the head commit (or the model)
 * changes; comment-only activity keeps the cached diff summary valid.
 */
async function prSummaryCacheKey(
  db: SqlDatabase,
  pullRequestId: string,
  model: string
): Promise<string> {
  const row = (await listPullRequestRows(db, { id: pullRequestId }))[0]
  const head = row?.latest_commit_sha ?? row?.github_updated_at ?? ""
  return hashContent(`pr-summary\n${model}\n${head}`)
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

async function isLocalDatabaseEmpty(db: SqlDatabase): Promise<boolean> {
  const row = (
    await db.select<Array<{ count: number }>>(
      `select count(*) as count from pull_requests`
    )
  )[0]
  return (row?.count ?? 0) === 0
}

async function listKnownOpenPullRequestSnapshots(
  db: SqlDatabase,
  source: ReturnType<typeof createGithubTokenPullRequestSource>,
  listedSnapshots: GitHubPullRequestSnapshot[]
): Promise<GitHubPullRequestSnapshot[]> {
  if (!source.getPullRequest) return []

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
  const snapshots: GitHubPullRequestSnapshot[] = []

  for (const row of rows) {
    const key = pullRequestKey(row.repository, row.number)
    if (!key || listedPullRequestKeys.has(key)) continue
    const snapshot = await source.getPullRequest({
      repository: row.repository,
      number: row.number,
    })
    if (!snapshot) continue
    snapshots.push(snapshot)
    listedPullRequestKeys.add(key)
  }

  return snapshots
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
    latestCommitSha: pullRequest.head?.sha ?? "",
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    statusCheckRollup: snapshot.status_check_rollup
      ? {
          state: snapshot.status_check_rollup.state,
          totalCount: snapshot.status_check_rollup.total_count,
        }
      : undefined,
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviews: reviews.flatMap(mapSnapshotReview),
    threads: (snapshot.review_threads ?? []).map((thread) =>
      mapSnapshotReviewThread(thread, updatedAt)
    ),
    activity: buildSnapshotActivity({ ...snapshot, reviews }),
  }
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

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[],
  avatarUrlByLogin: Map<string, string>
): Actor[] {
  const logins = new Set<string>(extraLogins)
  for (const pullRequest of pullRequests) {
    logins.add(pullRequest.authorId)
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

async function ensureBoardItemNotesColumn(db: SqlDatabase): Promise<void> {
  const rows = await db.select<Array<{ name: string }>>(
    `pragma table_info(board_items)`
  )
  if (rows.some((row) => row.name === "notes")) return

  await db.execute(`alter table board_items add column notes text`)
}

async function ensureBoardItemAttentionTimestampColumns(
  db: SqlDatabase
): Promise<void> {
  const rows = await db.select<Array<{ name: string }>>(
    `pragma table_info(board_items)`
  )
  const columnNames = new Set(rows.map((row) => row.name))

  for (const column of ["snoozed_at", "muted_at"]) {
    if (!columnNames.has(column)) {
      await db.execute(`alter table board_items add column ${column} text`)
    }
  }
}

async function ensurePullRequestSizeColumns(db: SqlDatabase): Promise<void> {
  const rows = await db.select<Array<{ name: string }>>(
    `pragma table_info(pull_requests)`
  )
  const columnNames = new Set(rows.map((row) => row.name))

  for (const column of ["additions", "deletions", "changed_files"]) {
    if (!columnNames.has(column)) {
      await db.execute(`alter table pull_requests add column ${column} integer`)
    }
  }
}

async function ensureReviewThreadLedgerColumns(db: SqlDatabase): Promise<void> {
  const rows = await db.select<Array<{ name: string }>>(
    `pragma table_info(review_threads)`
  )
  const columnNames = new Set(rows.map((row) => row.name))

  if (!columnNames.has("is_outdated")) {
    await db.execute(
      `alter table review_threads add column is_outdated integer not null default 0`
    )
  }
  if (!columnNames.has("last_actor_login")) {
    await db.execute(`alter table review_threads add column last_actor_login text`)
  }
}

function localGithubSettingsFingerprint(credentials: LocalGithubCredentials): string {
  return JSON.stringify({
    repositories: credentials.repositories,
    viewerLogin: credentials.viewerLogin,
    apiBaseUrl: credentials.apiBaseUrl,
    tokenLength: credentials.token.length,
  })
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

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
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
