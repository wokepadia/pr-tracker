/**
 * Prompt-iteration lab for the AI dashboard (the whole-queue brief), the
 * companion to codex-brief-lab.ts. Reproduces the exact prompt the desktop
 * app hands Codex for the board-scoped queue — classifying every open board
 * pull request from a snapshot of the real local database, enriching each with
 * its recent discussion — runs the real `codex exec`, and writes the prompt
 * and parsed dashboard to /tmp/brief-lab/dashboard.* for judging.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx scripts/codex-dashboard-lab.ts
 * Snapshot the live DB to /tmp/brief-lab.sqlite first. Needs a signed-in codex.
 */
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"

import {
  openLocalDatabase,
  listLocalPullRequestRows,
  listLocalReviewRequestRows,
  listLocalReviewEventRows,
  listLocalReviewThreadRows,
  listLocalActivityEventRows,
  listLocalPullRequestLabelRows,
  listLocalPullRequestAssigneeRows,
  listLocalReviewThreadParticipantRows,
  listLocalReviewCommentRows,
  listLocalIssueCommentRows,
  defaultLocalBoardId,
} from "../packages/db/src/local-sqlite.ts"
import { buildReviewerInbox } from "../packages/reviewer-workflow/src/index.ts"
import type { Actor, PullRequestItem } from "../packages/core/src/index.ts"
import { toReviewQueueItemView } from "../apps/desktop/src/reviewer/view-model.ts"
import {
  buildAiDashboardInput,
  buildAiDashboardPrompt,
  aiDashboardSchema,
  aiDashboardSchemaName,
  normalizeAiDashboardContent,
} from "../apps/desktop/src/ai/ai-dashboard.ts"
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  parseCodexJsonOutput,
} from "../apps/desktop/src/ai/codex.ts"

const DB_PATH = "/tmp/brief-lab.sqlite"
const OUT_DIR = "/tmp/brief-lab"
const MODEL = process.env.BRIEF_LAB_MODEL ?? "gpt-5.5"

type AnyRow = Record<string, any>

function parseStatusCheckRollup(json: string | null): PullRequestItem["statusCheckRollup"] {
  if (!json) return undefined
  try {
    const p = JSON.parse(json) as { state?: unknown; totalCount?: unknown }
    if (p.state !== "success" && p.state !== "failure" && p.state !== "pending") return undefined
    return { state: p.state, totalCount: typeof p.totalCount === "number" ? p.totalCount : undefined }
  } catch {
    return undefined
  }
}

function toPullRequestItem(db: any, row: AnyRow): PullRequestItem {
  const reviewRequests = listLocalReviewRequestRows(db, row.id) as AnyRow[]
  const reviews = listLocalReviewEventRows(db, row.id) as AnyRow[]
  const reviewThreads = listLocalReviewThreadRows(db, row.id) as AnyRow[]
  const activity = listLocalActivityEventRows(db, row.id) as AnyRow[]
  const labels = listLocalPullRequestLabelRows(db, row.id) as AnyRow[]
  const assignees = listLocalPullRequestAssigneeRows(db, row.id) as AnyRow[]
  const participants = listLocalReviewThreadParticipantRows(db, reviewThreads.map((t) => t.id)) as AnyRow[]
  const byThread = new Map<string, string[]>()
  for (const p of participants) byThread.set(p.review_thread_id, [...(byThread.get(p.review_thread_id) ?? []), p.login])
  return {
    id: row.id,
    repository: row.repository_full_name,
    number: row.number,
    title: row.title,
    description: row.body ?? undefined,
    url: row.url,
    authorId: row.author_login,
    state: row.merged_at ? "merged" : (row.state as PullRequestItem["state"]),
    isDraft: Boolean(row.is_draft),
    createdAt: row.github_created_at ?? new Date().toISOString(),
    updatedAt: row.github_updated_at ?? new Date().toISOString(),
    latestCommitSha: row.latest_commit_sha ?? "",
    labels: labels.map((l) => ({ name: l.name, color: l.color ?? undefined, description: l.description ?? undefined })),
    assigneeIds: assignees.map((a) => a.login),
    additions: row.additions ?? undefined,
    deletions: row.deletions ?? undefined,
    changedFiles: row.changed_files ?? undefined,
    statusCheckRollup: parseStatusCheckRollup(row.status_check_summary_json),
    requestedReviewerIds: reviewRequests.flatMap((r) => (r.login ? [r.login] : [])),
    reviews: reviews.map((r) => ({
      id: r.id,
      reviewerId: r.reviewer_login,
      decision: r.decision,
      submittedAt: r.submitted_at,
      commitSha: r.commit_sha ?? undefined,
      body: r.body ?? undefined,
    })),
    threads: reviewThreads.map((t) => ({
      id: t.id,
      isResolved: Boolean(t.is_resolved),
      isOutdated: Boolean(t.is_outdated),
      participantIds: byThread.get(t.id) ?? [],
      lastActorId: t.last_actor_login ?? undefined,
      filePath: t.file_path ?? undefined,
      line: t.line ?? undefined,
      lastActivityAt: t.last_activity_at,
    })),
    activity: activity.map((e) => ({
      id: e.id,
      type: e.event_type,
      actorId: e.actor_login,
      occurredAt: e.occurred_at,
      title: e.title,
      body: e.body ?? undefined,
      url: e.url ?? undefined,
      diffUrl: e.diff_url ?? undefined,
    })),
  }
}

function buildActors(prs: PullRequestItem[], viewerLogin: string): Actor[] {
  const logins = new Set<string>([viewerLogin])
  for (const pr of prs) {
    logins.add(pr.authorId)
    pr.assigneeIds?.forEach((l) => logins.add(l))
    pr.requestedReviewerIds.forEach((l) => logins.add(l))
    pr.reviews.forEach((r) => logins.add(r.reviewerId))
    pr.threads.forEach((t) => t.participantIds.forEach((l) => logins.add(l)))
    pr.activity.forEach((e) => logins.add(e.actorId))
  }
  return [...logins].map((login) => ({ id: login, login }))
}

function discussionComments(db: any, prId: string) {
  const review = listLocalReviewCommentRows(db, prId) as AnyRow[]
  const issue = listLocalIssueCommentRows(db, prId) as AnyRow[]
  const events = listLocalReviewEventRows(db, prId) as AnyRow[]
  return [
    ...issue.map((c) => ({ actor: c.author_login, body: c.body, occurredAt: c.created_at_github, source: "issue_comment" as const })),
    ...review.map((c) => ({
      actor: c.author_login,
      body: c.body,
      occurredAt: c.created_at_github,
      source: "review_comment" as const,
      filePath: c.file_path ?? undefined,
      line: c.line ?? undefined,
    })),
    ...events.flatMap((r) => (r.body ? [{ actor: r.reviewer_login, body: r.body, occurredAt: r.submitted_at, source: "review" as const }] : [])),
  ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

function lastSeenFor(db: any, prId: string): string | undefined {
  const rows = db
    .prepare(`select last_seen_at from board_items where board_id = ? and pull_request_id = ?`)
    .all(defaultLocalBoardId, prId) as AnyRow[]
  return rows[0]?.last_seen_at ?? undefined
}

function runCodex(system: string, user: string): Promise<{ raw: string; stderr: string; code: number }> {
  const prompt = buildCodexPrompt({ system, user, schemaName: aiDashboardSchemaName, schema: aiDashboardSchema })
  const args = buildCodexExecArgs({ model: MODEL, prompt })
  return new Promise((resolve) => {
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    const timer = setTimeout(() => child.kill("SIGKILL"), 420_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ raw: out, stderr: err, code: code ?? 1 })
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ raw: out, stderr: String(e), code: 1 })
    })
  })
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const local = openLocalDatabase({ path: DB_PATH })
  const db = local.db
  const viewerLogin =
    (db.prepare(`select github_login from local_profile limit 1`).all() as AnyRow[])[0]?.github_login ?? "viewer"

  const onBoard = new Set(
    (db.prepare(`select pull_request_id from board_items where board_id = ? and archived_at is null`).all(defaultLocalBoardId) as AnyRow[]).map(
      (r) => r.pull_request_id
    )
  )
  const prs = (listLocalPullRequestRows(db, {}) as AnyRow[])
    .filter((r) => onBoard.has(r.id) && r.state === "open" && !r.merged_at)
    .map((r) => toPullRequestItem(db, r))

  const actors = buildActors(prs, viewerLogin)
  const viewer = actors.find((a) => a.id === viewerLogin) ?? { id: viewerLogin, login: viewerLogin }
  const lastSeen: Record<string, string> = {}
  for (const pr of prs) {
    const s = lastSeenFor(db, pr.id)
    if (s) lastSeen[pr.id] = s
  }
  const inbox = buildReviewerInbox({ viewer, actors, pullRequests: prs, now: new Date().toISOString(), lastSeenAtByPullRequestId: lastSeen })
  const actorById = new Map(actors.map((a) => [a.id, a]))
  const items = inbox.items.map((c) => toReviewQueueItemView(c, actorById, viewer.id))

  const base = buildAiDashboardInput(items)
  const input = {
    ...base,
    items: base.items.map((it) => ({ ...it, discussionExcerpts: discussionComments(db, it.id).slice(-5) })),
  }
  const prompt = buildAiDashboardPrompt(input)
  writeFileSync(`${OUT_DIR}/dashboard.prompt.txt`, `=== SYSTEM ===\n${prompt.system}\n\n=== USER ===\n${prompt.user}`)
  console.log(
    `dashboard: open=${input.metrics.openReviewCount} yourMove=${input.metrics.yourMoveCount} author=${input.metrics.waitingOnAuthorCount} stalled=${input.metrics.stalledCount} cards=${input.items.length} promptChars=${prompt.user.length}`
  )

  let content: unknown
  let lastErr = ""
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`dashboard: running codex (${MODEL}) attempt ${attempt}…`)
    const { raw, stderr, code } = await runCodex(prompt.system, prompt.user)
    writeFileSync(`${OUT_DIR}/dashboard.raw.txt`, raw + (stderr ? `\n\n=== STDERR ===\n${stderr}` : ""))
    const parsed = parseCodexJsonOutput(raw)
    if (parsed.errorMessage || code !== 0 || !parsed.agentMessage) {
      lastErr = `codex failed code=${code} ${parsed.errorMessage ?? stderr.slice(0, 200)}`
      continue
    }
    try {
      let obj: any = JSON.parse(parsed.agentMessage.replace(/^```(?:json)?\s*|\s*```$/g, ""))
      if (obj && typeof obj === "object" && !("queueSummary" in obj) && obj[aiDashboardSchemaName]) {
        obj = obj[aiDashboardSchemaName]
      }
      content = normalizeAiDashboardContent(obj, input.items.map((i) => i.id))
      break
    } catch (e) {
      writeFileSync(`${OUT_DIR}/dashboard.agent.txt`, parsed.agentMessage)
      lastErr = String(e)
    }
  }
  if (!content) {
    console.log(`dashboard FAILED after retries: ${lastErr}`)
    local.close()
    process.exit(1)
  }
  writeFileSync(`${OUT_DIR}/dashboard.json`, JSON.stringify(content, null, 2))
  console.log(`dashboard OK → ${OUT_DIR}/dashboard.json`)
  local.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
