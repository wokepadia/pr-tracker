/**
 * Structured completions through the locally installed Codex CLI, for users
 * whose ChatGPT plan covers Codex usage. The CLI owns its own sign-in; the
 * app never sees or stores OpenAI credentials.
 *
 * `codex exec` has no inline JSON-schema flag the app can use without
 * writing temp files, so the schema is embedded in the prompt and the
 * response is validated client-side — the same domain normalizers that
 * guard the OpenRouter path run on this output too.
 *
 * Flags, verified against codex-cli 0.130.0:
 * - --ignore-user-config: deterministic behavior regardless of the user's
 *   ~/.codex/config.toml (auth still applies).
 * - -m <model>: required; the CLI's default model is rejected on
 *   ChatGPT-plan auth.
 * - --json: JSONL events on stdout; the final answer arrives as an
 *   item.completed event with an agent_message item.
 * - --ephemeral, --sandbox read-only, --skip-git-repo-check: no session
 *   files, no shell/file access, no repo required.
 */

export interface CodexExecResult {
  code: number
  stdout: string
  stderr: string
}

export type CodexRunner = (args: string[]) => Promise<CodexExecResult>

export interface CodexCompletionInput {
  model: string
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  run: CodexRunner
}

export function buildCodexExecArgs(input: {
  model: string
  prompt: string
}): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--json",
    "-m",
    input.model,
    input.prompt,
  ]
}

export function buildCodexPrompt(input: {
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
}): string {
  return [
    input.system,
    "",
    input.user,
    "",
    `Respond with ONLY a single JSON object named ${input.schemaName} that conforms to this JSON Schema — no prose, no code fences, no explanations:`,
    JSON.stringify(input.schema),
  ].join("\n")
}

export async function requestCodexStructuredCompletion<T>(
  input: CodexCompletionInput
): Promise<T> {
  const prompt = buildCodexPrompt(input)
  let result: CodexExecResult
  try {
    result = await input.run(buildCodexExecArgs({ model: input.model, prompt }))
  } catch {
    throw new Error(
      "Could not run the Codex CLI. Install it and sign in with `codex login`, then try again."
    )
  }

  const parsed = parseCodexJsonOutput(result.stdout)
  if (parsed.errorMessage || result.code !== 0) {
    throw new Error(
      mapCodexErrorMessage(parsed.errorMessage ?? result.stderr.trim())
    )
  }
  if (!parsed.agentMessage) {
    throw new Error("Codex returned no response. Try again.")
  }

  try {
    return JSON.parse(stripCodeFences(parsed.agentMessage)) as T
  } catch {
    throw new Error(
      "Codex returned a response that was not valid JSON. Try again or switch models in Settings."
    )
  }
}

/**
 * Walks the JSONL event stream from `codex exec --json`: the last
 * agent_message item carries the final answer; error and turn.failed
 * events carry failure detail.
 */
export function parseCodexJsonOutput(stdout: string): {
  agentMessage?: string
  errorMessage?: string
} {
  let agentMessage: string | undefined
  let errorMessage: string | undefined

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue

    let event: {
      type?: string
      message?: string
      error?: { message?: string }
      item?: { type?: string; text?: string }
    }
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      agentMessage = event.item.text
    }
    if (event.type === "error" && typeof event.message === "string") {
      errorMessage = event.message
    }
    if (event.type === "turn.failed" && event.error?.message) {
      errorMessage = event.error.message
    }
  }

  return { agentMessage, errorMessage }
}

function mapCodexErrorMessage(raw: string): string {
  const detail = extractNestedErrorMessage(raw)
  if (/not supported when using codex with a chatgpt account/i.test(detail)) {
    return `Codex rejected the model for ChatGPT-plan accounts. Pick a plan-supported model in Settings. (${detail})`
  }
  if (/login|unauthorized|401|not signed in|auth/i.test(detail)) {
    return "Codex is not signed in. Run `codex login` in a terminal, then try again."
  }
  if (/usage limit|rate limit|429/i.test(detail)) {
    return "Codex reports your plan's usage limit is reached. Wait for the window to reset and try again."
  }

  return detail
    ? `Codex error: ${detail}`
    : "Codex failed without an error message. Try again."
}

/** Codex error events often wrap a JSON error body in the message string. */
function extractNestedErrorMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } }
    if (typeof body.error?.message === "string") {
      return body.error.message
    }
  } catch {
    // Plain-text message; use as is.
  }
  return raw
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  return fenced?.[1] ?? trimmed
}
