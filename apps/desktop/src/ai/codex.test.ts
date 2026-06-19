import { describe, expect, it } from "vitest"

import {
  buildCodexChatPrompt,
  buildCodexExecArgs,
  buildCodexPrompt,
  parseCodexJsonOutput,
  requestCodexChat,
  requestCodexStructuredCompletion,
  unwrapSchemaEnvelope,
  type CodexExecResult,
} from "./codex"

// Event shapes below were captured from a real codex-cli 0.130.0 run.
const successStdout = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\": true}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13430,"output_tokens":27}}',
].join("\n")

const modelRejectedStdout = [
  '{"type":"thread.started","thread_id":"t2"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  // The real CLI repeats the same payload on turn.failed.
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The model is not supported when using Codex with a ChatGPT account.\\"}}"}',
].join("\n")

function runner(result: Partial<CodexExecResult>) {
  return async () => ({ code: 0, stdout: "", stderr: "", ...result })
}

function completionInput(run: ReturnType<typeof runner>) {
  return {
    model: "gpt-5.5",
    system: "You summarize.",
    user: "Summarize this.",
    schemaName: "pr_summary",
    schema: { type: "object" } as Record<string, unknown>,
    run,
  }
}

describe("buildCodexChatPrompt", () => {
  it("renders the grounding block and the transcript into one prompt", () => {
    const prompt = buildCodexChatPrompt({
      system: "Board context.",
      messages: [
        { role: "user", content: "Which PRs need me?" },
        { role: "assistant", content: "PR #42 does." },
        { role: "user", content: "Why?" },
      ],
    })
    expect(prompt).toContain("Board context.")
    expect(prompt).toContain("Conversation so far:")
    expect(prompt).toContain("User: Which PRs need me?")
    expect(prompt).toContain("Assistant: PR #42 does.")
    expect(prompt).toContain("User: Why?")
    expect(prompt).toContain("Write the Assistant's next reply as plain text")
  })
})

describe("requestCodexChat", () => {
  const chatStdout = [
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"PR #42 is waiting on you."}}',
    '{"type":"turn.completed"}',
  ].join("\n")

  it("returns the agent message as plain text", async () => {
    const answer = await requestCodexChat({
      model: "gpt-5.5",
      system: "ctx",
      messages: [{ role: "user", content: "Which PR?" }],
      run: runner({ code: 0, stdout: chatStdout }),
    })
    expect(answer).toBe("PR #42 is waiting on you.")
  })

  it("maps a not-signed-in failure to actionable guidance", async () => {
    await expect(
      requestCodexChat({
        model: "gpt-5.5",
        system: "ctx",
        messages: [{ role: "user", content: "Which PR?" }],
        run: runner({
          code: 1,
          stdout: '{"type":"error","message":"401 unauthorized: not signed in"}',
        }),
      })
    ).rejects.toThrow("Codex is not signed in.")
  })
})

describe("buildCodexExecArgs", () => {
  it("locks down the exec invocation and passes the model explicitly", () => {
    expect(buildCodexExecArgs({ model: "gpt-5.5", prompt: "p" })).toEqual([
      "exec",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--json",
      "-m",
      "gpt-5.5",
      "p",
    ])
  })
})

describe("buildCodexPrompt", () => {
  it("embeds the schema with a JSON-only instruction", () => {
    const prompt = buildCodexPrompt({
      system: "sys",
      user: "usr",
      schemaName: "queue_brief",
      schema: { type: "object" },
    })
    expect(prompt).toContain("sys\n\nusr")
    expect(prompt).toContain("named queue_brief")
    expect(prompt).toContain('{"type":"object"}')
    expect(prompt).toContain("no code fences")
  })
})

describe("parseCodexJsonOutput", () => {
  it("extracts the final agent message", () => {
    expect(parseCodexJsonOutput(successStdout)).toEqual({
      agentMessage: '{"ok": true}',
      errorMessage: undefined,
    })
  })

  it("extracts error events and ignores non-JSON lines", () => {
    const parsed = parseCodexJsonOutput(
      `garbage line\n${modelRejectedStdout}`
    )
    expect(parsed.agentMessage).toBeUndefined()
    expect(parsed.errorMessage).toContain("not supported when using Codex")
  })
})

describe("requestCodexStructuredCompletion", () => {
  it("parses the agent message as JSON", async () => {
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout: successStdout }))
      )
    ).resolves.toEqual({ ok: true })
  })

  it("strips code fences before parsing", async () => {
    const fenced = '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"ok\\": 1}\\n```"}}'
    await expect(
      requestCodexStructuredCompletion(completionInput(runner({ stdout: fenced })))
    ).resolves.toEqual({ ok: 1 })
  })

  it("maps the ChatGPT-plan model rejection to a settings hint", async () => {
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout: modelRejectedStdout, code: 1 }))
      )
    ).rejects.toThrow(
      /Codex rejected the model for ChatGPT-plan accounts. Pick a plan-supported model in Settings./
    )
  })

  it("maps auth failures to a codex login hint", async () => {
    const stdout = '{"type":"error","message":"401 Unauthorized: not signed in"}'
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout, code: 1 }))
      )
    ).rejects.toThrow(
      "Codex is not signed in. Run `codex login` in a terminal, then try again."
    )
  })

  it("maps spawn failures to an install hint", async () => {
    const failingRun = async () => {
      throw new Error("spawn codex ENOENT")
    }
    await expect(
      requestCodexStructuredCompletion(completionInput(failingRun))
    ).rejects.toThrow(
      "Could not run the Codex CLI. Install it and sign in with `codex login`, then try again."
    )
  })

  it("rejects empty and malformed agent messages", async () => {
    const noMessage = '{"type":"turn.completed","usage":{}}'
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout: noMessage }))
      )
    ).rejects.toThrow("Codex returned no response. Try again.")

    const notJson =
      '{"type":"item.completed","item":{"type":"agent_message","text":"sorry, here is prose"}}'
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout: notJson }))
      )
    ).rejects.toThrow(
      "Codex returned a response that was not valid JSON. Try again or switch models in Settings."
    )
  })

  it("unwraps a payload Codex nested under the schema name", async () => {
    const wrapped =
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"pr_summary\\":{\\"ok\\":true}}"}}'
    await expect(
      requestCodexStructuredCompletion(
        completionInput(runner({ stdout: wrapped }))
      )
    ).resolves.toEqual({ ok: true })
  })
})

describe("unwrapSchemaEnvelope", () => {
  it("unwraps a single-key envelope matching the schema name", () => {
    expect(unwrapSchemaEnvelope({ pr_brief: { yourMove: "go" } }, "pr_brief")).toEqual({
      yourMove: "go",
    })
  })

  it("leaves a bare payload untouched", () => {
    const bare = { yourMove: "go", pr_brief: "a field that happens to share the name" }
    expect(unwrapSchemaEnvelope(bare, "pr_brief")).toBe(bare)
  })
})
