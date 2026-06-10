import type {
  Actor,
  PullRequestActivity,
  PullRequestItem,
  ReviewDecisionEvent,
  ReviewThread,
} from "@pr-tracker/core"
import {
  sampleLastSeenAtByPullRequestId,
  samplePullRequests,
} from "@pr-tracker/core"
import {
  createGithubTokenPullRequestSource,
  getGithubClosedLookbackDays,
  parseGithubRepositories,
  type GitHubPullRequestSnapshot,
  type GitHubReviewSnapshot,
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
  BoardState,
  GithubSettingsStatus,
  OnboardingState,
  PullRequestDetailResponse,
  SaveGithubSettingsInput,
  SqliteBackupResult,
} from "@/api"
import { logRendererError } from "@/lib/error-logging"
import { localDesktopSchemaSql } from "../../../../packages/db/src/local-schema"
import { createQueuedTransaction } from "./sqlite-transaction"

const databaseUrl = "sqlite:pr-tracker.sqlite"
const defaultLocalProfileId = "local"
const defaultLocalBoardId = "default-board"
const githubSettingsKey = "github-settings"
const onboardingSettingsKey = "onboarding"
const strongholdPasswordSettingsKey = "stronghold-unlock-secret"
const githubTokenStoreKey = "github-token"
const strongholdClientName = "review-ninja"
const strongholdFilename = "github-token.stronghold"
const desktopTokenStorage = "stronghold"
let cachedToken: string | undefined
let tokenReadPromise: Promise<string | undefined> | undefined
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
  github_created_at: string | null
  github_updated_at: string | null
  raw_payload_json: string
}

interface LocalBoardItemStateRow {
  pull_request_id: string
  column_id: string | null
  sort_order: number
  last_seen_at: string | null
  notes: string | null
  is_snoozed: number
  is_muted: number
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
  const readScope = input?.githubSearchQuery
    ? await syncBeforeRead(db, input)
    : await syncBeforeReadWithTimeout(db, input, 6_000)
  const pullRequests = await loadPullRequests(db, {
    ids: input?.githubSearchQuery ? readScope?.pullRequestIds ?? [] : undefined,
  })
  const settings = await readLocalGithubSettings(db)
  const viewerLogin = settings.viewerLogin ?? "viewer"
  const actors = buildActors(pullRequests, [viewerLogin])
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
  await syncBeforeRead(db)
  const pullRequests = await loadPullRequests(db, id)
  const pullRequest = pullRequests[0]
  if (!pullRequest) {
    throw new Error("Pull request not found.")
  }

  const settings = await readLocalGithubSettings(db)
  const viewerLogin = settings.viewerLogin ?? "viewer"
  const actors = buildActors(pullRequests, [viewerLogin])
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
  await syncBeforeReadWithTimeout(db, undefined, 6_000)
  return loadBoardState(db)
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
      muted?: boolean
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
      muted: itemState.muted,
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
            notes, is_snoozed, is_muted, is_pinned, created_at, updated_at, archived_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, null)
          on conflict(board_id, pull_request_id)
          do update set
            column_id = excluded.column_id,
            sort_order = excluded.sort_order,
            notes = excluded.notes,
            is_snoozed = excluded.is_snoozed,
            is_muted = excluded.is_muted,
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
          boolToSqlite(Boolean(item.muted)),
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

async function syncBeforeReadWithTimeout(
  db: SqlDatabase,
  options: { githubSearchQuery?: string } | undefined,
  timeoutMs: number
): Promise<{ pullRequestIds?: string[] } | undefined> {
  const syncPromise = syncBeforeRead(db, options)
  let didTimeOut = false
  const timeoutPromise = delay(timeoutMs).then(() => {
    didTimeOut = true
    return undefined
  })
  let result: { pullRequestIds?: string[] } | undefined
  try {
    result = await Promise.race([syncPromise, timeoutPromise])
  } catch (error) {
    if (await isLocalDatabaseEmpty(db)) {
      throw error
    }
    void logRendererError("Foreground GitHub sync failed; using cached data", error)
    return undefined
  }

  if (didTimeOut) {
    syncPromise.catch((error) => {
      void logRendererError("Background GitHub sync failed", error)
    })
  }

  return result
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
  })
  await ensureDefaultBoardItem(db, storedPullRequestId, now)
  return { pullRequestId: storedPullRequestId, isFreshEnough: true }
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
  options: { githubNodeId?: string; rawPayload?: unknown } = {}
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
        github_created_at, github_updated_at, raw_payload_json, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        github_created_at = excluded.github_created_at,
        github_updated_at = excluded.github_updated_at,
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
      pullRequest.state === "merged" ? "closed" : pullRequest.state,
      boolToSqlite(pullRequest.isDraft),
      pullRequest.latestCommitSha,
      pullRequest.createdAt,
      pullRequest.updatedAt,
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
  await replaceThreads(db, storedPullRequest.threads, storedPullRequest.id, now)
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
          id, pull_request_id, github_node_id, is_resolved, file_path,
          line, last_activity_at, raw_payload_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        thread.id,
        pullRequestId,
        thread.id,
        boolToSqlite(thread.isResolved),
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
      muted: row.is_muted ? true : undefined,
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

  const scopeSql = input.id
    ? "pr.id = $1"
    : scopedIds
      ? `pr.id in (${scopedIds.map((_, index) => `$${index + 1}`).join(", ")})`
      : "pr.state = 'open'"
  const parameters = input.id ? [input.id] : scopedIds ?? []

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
        pr.github_created_at,
        pr.github_updated_at,
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
    state: row.state as PullRequestItem["state"],
    isDraft: Boolean(row.is_draft),
    createdAt: row.github_created_at ?? new Date().toISOString(),
    updatedAt: row.github_updated_at ?? new Date().toISOString(),
    latestCommitSha: row.latest_commit_sha ?? "",
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
      participantIds: participantIdsByThreadId.get(thread.id) ?? [],
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
      file_path: string | null
      line: number | null
      last_activity_at: string
    }>
  >(
    `
      select id, pull_request_id, is_resolved, file_path, line, last_activity_at
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
        is_muted,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function normalizeOnboardingVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 1
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
    requestedReviewerIds: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => reviewer.login)
      .filter((login): login is string => Boolean(login)),
    reviews: reviews.flatMap(mapSnapshotReview),
    threads: [],
    activity: buildSnapshotActivity({ ...snapshot, reviews }),
  }
}

function buildActors(
  pullRequests: PullRequestItem[],
  extraLogins: string[]
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

  return Array.from(logins).map((login) => ({ id: login, login }))
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
