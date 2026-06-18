/**
 * Prompt-iteration lab for the PR brief. Reproduces EXACTLY the prompt the
 * desktop app hands the Codex CLI for a real pull request — metadata, waiting
 * state, threads, comments, and the live diff — runs the real `codex exec`,
 * and writes the prompt + raw response + parsed brief to /tmp/brief-lab for
 * judging. Diffs come from the public GitHub repo via `gh`; everything else
 * comes from a snapshot of the real local database.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.base.json npx tsx scripts/codex-brief-lab.ts [number ...]
 * (the tsconfig env lets tsx resolve the @pr-tracker/* path aliases used by
 * the app modules this imports). Requires `gh` (public-repo diffs) and a
 * signed-in `codex` CLI. Snapshot the live DB to /tmp/brief-lab.sqlite first.
 */
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
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
import { toReviewQueueItemView } from "../apps/desktop/src/reviewer/view-model"
import {
  buildPrBriefPrompt,
  prBriefSchema,
  prBriefSchemaName,
  normalizePrBriefContent,
  threadLocationKey,
  type PrBriefThreadInput,
  type PrBriefCommentInput,
  type PrBriefEventInput,
  type PrBriefFileInput,
} from "../apps/desktop/src/ai/pr-brief"
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  parseCodexJsonOutput,
} from "../apps/desktop/src/ai/codex"

const execFileAsync = promisify(execFile)
const DB_PATH = "/tmp/brief-lab.sqlite"
const OUT_DIR = "/tmp/brief-lab"
const MODEL = process.env.BRIEF_LAB_MODEL ?? "gpt-5.5"
const numbers = (process.argv.slice(2).length ? process.argv.slice(2) : ["37409", "38175", "34814"]).map(Number)

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
  for (const p of participants) {
    byThread.set(p.review_thread_id, [...(byThread.get(p.review_thread_id) ?? []), p.login])
  }
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

function buildActors(pr: PullRequestItem, viewerLogin: string): Actor[] {
  const logins = new Set<string>([viewerLogin, pr.authorId])
  pr.assigneeIds?.forEach((l) => logins.add(l))
  pr.requestedReviewerIds.forEach((l) => logins.add(l))
  pr.reviews.forEach((r) => logins.add(r.reviewerId))
  pr.threads.forEach((t) => t.participantIds.forEach((l) => logins.add(l)))
  pr.activity.forEach((e) => logins.add(e.actorId))
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

function briefThreads(db: any, prId: string, viewerLogin: string): { threads: PrBriefThreadInput[]; allowedFiles: string[] } {
  const rows = listLocalReviewThreadRows(db, prId) as AnyRow[]
  if (rows.length === 0) return { threads: [], allowedFiles: [] }
  const participants = listLocalReviewThreadParticipantRows(db, rows.map((t) => t.id)) as AnyRow[]
  const byThread = new Map<string, string[]>()
  for (const p of participants) byThread.set(p.review_thread_id, [...(byThread.get(p.review_thread_id) ?? []), p.login])
  const lower = viewerLogin.toLowerCase()
  const threads: PrBriefThreadInput[] = rows.map((t) => {
    const isResolved = t.is_resolved === 1
    return {
      filePath: t.file_path ?? undefined,
      line: t.line ?? undefined,
      status: isResolved ? "resolved" : "unresolved",
      awaitingYourReply: !isResolved && (t.last_actor_login ?? "").toLowerCase() !== lower,
      isOutdated: t.is_outdated === 1,
      lastActorLogin: t.last_actor_login ?? undefined,
      participants: byThread.get(t.id) ?? [],
    }
  })
  return {
    threads,
    allowedFiles: rows.flatMap((t) => (t.file_path ? [threadLocationKey(t.file_path, t.line ?? undefined)] : [])),
  }
}

function briefNewEvents(db: any, prId: string): PrBriefEventInput[] {
  const lastSeen = lastSeenFor(db, prId)
  const events = (listLocalActivityEventRows(db, prId) as AnyRow[]).filter((e) => !lastSeen || e.occurred_at > lastSeen)
  const comments = discussionComments(db, prId).filter((c) => !lastSeen || c.occurredAt > lastSeen)
  return [
    ...events.map((e) => ({ type: e.event_type, actor: e.actor_login, title: e.title, body: e.body ?? undefined, occurredAt: e.occurred_at })),
    ...comments.map((c: any) => ({
      type: c.source,
      actor: c.actor,
      title: c.filePath ? `Commented on ${c.filePath}${c.line ? `:${c.line}` : ""}` : "Commented on the pull request",
      body: c.body,
      occurredAt: c.occurredAt,
    })),
  ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
}

async function fetchFiles(repository: string, number: number): Promise<PrBriefFileInput[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${repository}/pulls/${number}/files`, "--paginate"],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  // --paginate concatenates JSON arrays; normalize to one array.
  const arrays = stdout.replace(/\]\s*\[/g, ",").trim()
  const files = JSON.parse(arrays) as AnyRow[]
  return files.map((f) => ({
    path: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: f.patch ?? undefined,
  }))
}

function runCodex(system: string, user: string): Promise<{ raw: string; stderr: string; code: number }> {
  const prompt = buildCodexPrompt({ system, user, schemaName: prBriefSchemaName, schema: prBriefSchema })
  const args = buildCodexExecArgs({ model: MODEL, prompt })
  // stdin must be a closed/empty stream (not an open pipe) or `codex exec`
  // waits on stdin ("Reading additional input from stdin…") instead of using
  // the positional prompt — matching how the desktop app spawns it.
  return new Promise((resolve) => {
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    const timer = setTimeout(() => child.kill("SIGKILL"), 360_000)
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

  for (const number of numbers) {
    const row = (listLocalPullRequestRows(db, {}) as AnyRow[]).find((r) => r.number === number)
    if (!row) {
      console.log(`#${number}: not found in DB`)
      continue
    }
    const pr = toPullRequestItem(db, row)
    const actors = buildActors(pr, viewerLogin)
    const viewer = actors.find((a) => a.id === viewerLogin) ?? { id: viewerLogin, login: viewerLogin }
    const inbox = buildReviewerInbox({
      viewer,
      actors,
      pullRequests: [pr],
      now: new Date().toISOString(),
      lastSeenAtByPullRequestId: Object.fromEntries(
        [pr.id].map((id) => [id, lastSeenFor(db, id)]).filter(([, v]) => v) as [string, string][]
      ),
    })
    const classified = inbox.items[0] ?? inbox.inactiveItems?.[0]
    if (!classified) {
      console.log(`#${number}: could not classify`)
      continue
    }
    const item = toReviewQueueItemView(classified, new Map(actors.map((a) => [a.id, a])), viewer.id)
    const { threads, allowedFiles } = briefThreads(db, pr.id, viewerLogin)
    const comments: PrBriefCommentInput[] = discussionComments(db, pr.id) as PrBriefCommentInput[]
    const newEvents = briefNewEvents(db, pr.id)

    console.log(`\n#${number} ${pr.title} — fetching diff…`)
    const files = await fetchFiles(pr.repository, pr.number)

    const prompt = buildPrBriefPrompt({
      repository: item.repository,
      number: item.number,
      title: item.title,
      body: row.body ?? undefined,
      authorLogin: item.authorLogin,
      viewerLogin,
      state: item.state,
      isDraft: pr.isDraft,
      additions: item.size?.additions,
      deletions: item.size?.deletions,
      changedFiles: item.size?.fileCount,
      waitingOn: item.waitingOn,
      waitingAge: item.waitingAge,
      waitingUrgency: item.waitingUrgency,
      isStalled: item.workflowState === "stale" || item.waitingUrgency === "overdue",
      reason: item.reason,
      userLastReviewDecision: item.userLastReviewDecision,
      approvalStale: item.approvalStale,
      reviewRounds: item.reviewRounds,
      checksState: item.checks?.state,
      lastSeenLabel: item.lastSeenAtIso ? item.lastSeenAt : undefined,
      otherReviewers: item.otherReviewers.map((r) => ({ login: r.login, decision: r.decision })),
      newEvents,
      threads,
      comments,
      files,
    })

    console.log(
      `#${number} waitingOn=${item.waitingOn} reason="${item.reason}" threads=${threads.length} comments=${comments.length} newEvents=${newEvents.length} files=${files.length} promptChars=${prompt.user.length}`
    )
    writeFileSync(`${OUT_DIR}/${number}.prompt.txt`, `=== SYSTEM ===\n${prompt.system}\n\n=== USER ===\n${prompt.user}`)

    let brief: unknown
    let lastErr = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`#${number} running codex (${MODEL}) attempt ${attempt}…`)
      const { raw, stderr, code } = await runCodex(prompt.system, prompt.user)
      writeFileSync(`${OUT_DIR}/${number}.raw.txt`, raw + (stderr ? `\n\n=== STDERR ===\n${stderr}` : ""))
      const parsed = parseCodexJsonOutput(raw)
      if (parsed.errorMessage || code !== 0 || !parsed.agentMessage) {
        lastErr = `codex failed code=${code} ${parsed.errorMessage ?? stderr.slice(0, 200)}`
        continue
      }
      try {
        let obj: any = JSON.parse(parsed.agentMessage.replace(/^```(?:json)?\s*|\s*```$/g, ""))
        // Codex sometimes wraps the object under the schema name it was told to use.
        if (obj && typeof obj === "object" && !("yourMove" in obj) && obj[prBriefSchemaName]) {
          obj = obj[prBriefSchemaName]
        }
        brief = normalizePrBriefContent(obj, allowedFiles)
        break
      } catch (e) {
        writeFileSync(`${OUT_DIR}/${number}.agent.txt`, parsed.agentMessage)
        lastErr = String(e)
      }
    }
    if (!brief) {
      console.log(`#${number} FAILED after retries: ${lastErr}`)
      continue
    }
    writeFileSync(`${OUT_DIR}/${number}.brief.json`, JSON.stringify(brief, null, 2))
    console.log(`#${number} OK → ${OUT_DIR}/${number}.brief.json`)
  }
  local.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
