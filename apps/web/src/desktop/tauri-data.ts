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
  getPassword,
  setPassword,
} from "tauri-plugin-keyring-api"
import type {
  BoardState,
  GithubSettingsStatus,
  PullRequestDetailResponse,
  SaveGithubSettingsInput,
} from "@/api"
import { localDesktopSchemaSql } from "../../../../packages/db/src/local-schema"

const databaseUrl = "sqlite:pr-tracker.sqlite"
const defaultLocalProfileId = "local"
const defaultLocalBoardId = "default-board"
const githubSettingsKey = "github-settings"
const keychainService = "pr-tracker.github-token"
const keychainAccount = "github-token"

type SqlValue = string | number | boolean | null

interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>
  select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

interface LocalGithubSettings {
  repositories: string[]
  viewerLogin?: string
  apiBaseUrl?: string
}

interface LocalGithubCredentials extends LocalGithubSettings {
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

let databasePromise: Promise<SqlDatabase> | undefined
let lastSuccessfulSyncFingerprint: string | undefined

export async function getDesktopReviewerInbox(input?: {
  githubSearchQuery?: string
}) {
  const db = await getDatabase()
  await syncBeforeRead(db, input)
  const pullRequests = await loadPullRequests(db)
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
  await syncBeforeRead(db)
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
            is_snoozed, is_muted, is_pinned, created_at, updated_at, archived_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null)
          on conflict(board_id, pull_request_id)
          do update set
            column_id = excluded.column_id,
            sort_order = excluded.sort_order,
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
  const [settings, token] = await Promise.all([
    readLocalGithubSettings(db),
    readToken(),
  ])

  return {
    ...settings,
    tokenConfigured: Boolean(token),
    storage: "os-keychain",
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
  if (token) {
    await setPassword(keychainService, keychainAccount, token)
  }

  const existingToken = token || (await readToken())
  if (!existingToken) {
    throw new Error("A GitHub token is required.")
  }

  await writeLocalGithubSettings(db, {
    repositories,
    viewerLogin: cleanOptionalString(input.viewerLogin),
    apiBaseUrl: cleanOptionalString(input.apiBaseUrl),
  })
  lastSuccessfulSyncFingerprint = undefined

  return getDesktopGithubSettingsStatus()
}

async function getDatabase(): Promise<SqlDatabase> {
  databasePromise ??= initializeDatabase()
  return databasePromise
}

async function initializeDatabase(): Promise<SqlDatabase> {
  const db = await Database.load(databaseUrl)
  await db.execute("pragma foreign_keys = on")
  for (const statement of splitSqlStatements(localDesktopSchemaSql)) {
    await db.execute(statement)
  }
  return db
}

async function syncBeforeRead(
  db: SqlDatabase,
  options: { githubSearchQuery?: string } = {}
): Promise<void> {
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
    return
  }

  const source = createGithubTokenPullRequestSource({
    token: credentials.token,
    repositories: credentials.repositories,
    apiBaseUrl: credentials.apiBaseUrl,
    closedLookbackDays: getGithubClosedLookbackDays({}),
  })
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

  await transaction(db, async () => {
    for (const snapshot of snapshotsToIngest) {
      await upsertLocalPullRequestSnapshot(db, snapshot, { viewerLogin })
    }
  })

  lastSuccessfulSyncFingerprint = fingerprint
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
      await upsertPullRequestItem(db, pullRequest, now)
      await ensureDefaultBoardItem(db, pullRequest.id, now)
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
): Promise<void> {
  const pullRequest = snapshotToPullRequestItem(snapshot)
  const githubNodeId = githubNodeIdFromSnapshot(snapshot)
  const incomingUpdatedAt = pullRequest.updatedAt
  const current = (
    await db.select<Array<{ github_updated_at: string | null }>>(
      `select github_updated_at from pull_requests where github_node_id = $1`,
      [githubNodeId]
    )
  )[0]

  if (
    current?.github_updated_at &&
    Date.parse(incomingUpdatedAt) < Date.parse(current.github_updated_at)
  ) {
    return
  }

  const now = new Date().toISOString()
  await upsertLocalProfile(db, {
    githubLogin: options.viewerLogin ?? "viewer",
    displayName: options.viewerLogin ?? "viewer",
    now,
  })
  await ensureDefaultBoard(db, now)
  await upsertPullRequestItem(db, pullRequest, now, {
    githubNodeId,
    rawPayload: snapshot,
  })
  await ensureDefaultBoardItem(db, pullRequest.id, now)
}

async function upsertPullRequestItem(
  db: SqlDatabase,
  pullRequest: PullRequestItem,
  now: string,
  options: { githubNodeId?: string; rawPayload?: unknown } = {}
): Promise<void> {
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

  await replaceReviewRequests(db, pullRequest, now)
  await replaceReviews(db, pullRequest.reviews, pullRequest.id, now)
  await replaceThreads(db, pullRequest.threads, pullRequest.id, now)
  await replaceActivity(db, pullRequest.activity, pullRequest.id, now)
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
  id?: string
): Promise<PullRequestItem[]> {
  const rows = await listPullRequestRows(db, id)
  const pullRequests: PullRequestItem[] = []
  for (const row of rows) {
    pullRequests.push(await toPullRequestItem(db, row))
  }
  return pullRequests
}

async function listPullRequestRows(
  db: SqlDatabase,
  id?: string
): Promise<LocalPullRequestRow[]> {
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
      where ($1 is null or pr.id = $1)
        and ($1 is not null or pr.state = 'open')
      order by pr.github_updated_at desc
      limit 250
    `,
    [id ?? null]
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
  const row = (
    await db.select<Array<{ value_json: string }>>(
      `select value_json from app_settings where key = $1`,
      [githubSettingsKey]
    )
  )[0]
  if (!row) return { repositories: [] }

  const parsed = JSON.parse(row.value_json) as {
    repositories?: unknown
    viewerLogin?: unknown
    apiBaseUrl?: unknown
  }

  return {
    repositories: Array.isArray(parsed.repositories)
      ? parseGithubRepositories(parsed.repositories.join(","))
      : [],
    viewerLogin:
      typeof parsed.viewerLogin === "string" ? parsed.viewerLogin : undefined,
    apiBaseUrl:
      typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : undefined,
  }
}

async function writeLocalGithubSettings(
  db: SqlDatabase,
  settings: LocalGithubSettings
): Promise<void> {
  await db.execute(
    `
      insert into app_settings (key, value_json, updated_at)
      values ($1, $2, $3)
      on conflict(key)
      do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
    [githubSettingsKey, JSON.stringify(settings), new Date().toISOString()]
  )
}

async function loadLocalGithubCredentials(
  db: SqlDatabase
): Promise<LocalGithubCredentials | undefined> {
  const settings = await readLocalGithubSettings(db)
  if (settings.repositories.length === 0) {
    return undefined
  }
  const token = await readToken()
  return token ? { ...settings, token } : undefined
}

async function readToken(): Promise<string | undefined> {
  return (await getPassword(keychainService, keychainAccount)) ?? undefined
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

async function transaction<T>(
  db: SqlDatabase,
  callback: () => Promise<T>
): Promise<T> {
  await db.execute("begin")
  try {
    const result = await callback()
    await db.execute("commit")
    return result
  } catch (error) {
    await db.execute("rollback").catch(() => undefined)
    throw error
  }
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
