import { describe, expect, it } from "vitest"

import { hashContent } from "./content-hash"
import {
  requestStructuredCompletion,
  type StructuredCompletionInput,
} from "./openrouter"

function completionInput(
  fetchImpl: typeof fetch
): StructuredCompletionInput {
  return {
    apiKey: "sk-or-test",
    model: "anthropic/claude-sonnet-4.6",
    system: "You summarize pull requests.",
    user: "Summarize this.",
    schemaName: "summary",
    schema: { type: "object" },
    fetchImpl,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("requestStructuredCompletion", () => {
  it("sends a structured-output request and parses the JSON content", async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse({
        choices: [{ message: { content: '{"overview":"Adds retries."}' } }],
      })
    }

    const result = await requestStructuredCompletion<{ overview: string }>(
      completionInput(fetchImpl)
    )

    expect(result).toEqual({ overview: "Adds retries." })
    expect(captured?.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions"
    )
    const headers = captured?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer sk-or-test")
    const body = JSON.parse(String(captured?.init.body))
    expect(body.model).toBe("anthropic/claude-sonnet-4.6")
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "summary", strict: true, schema: { type: "object" } },
    })
    expect(body.messages).toHaveLength(2)
  })

  it("maps auth failures to a settings-oriented message", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { message: "bad key" } }, 401)

    await expect(
      requestStructuredCompletion(completionInput(fetchImpl))
    ).rejects.toThrow("OpenRouter rejected the API key. Check the key in Settings.")
  })

  it("surfaces provider error messages from non-2xx responses", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { message: "model not found" } }, 404)

    await expect(
      requestStructuredCompletion(completionInput(fetchImpl))
    ).rejects.toThrow("OpenRouter error: model not found")
  })

  it("rejects 200 responses that carry an error body", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { message: "provider unavailable" } })

    await expect(
      requestStructuredCompletion(completionInput(fetchImpl))
    ).rejects.toThrow("OpenRouter error: provider unavailable")
  })

  it("rejects empty and malformed completion content", async () => {
    const empty: typeof fetch = async () =>
      jsonResponse({ choices: [{ message: { content: "" } }] })
    await expect(
      requestStructuredCompletion(completionInput(empty))
    ).rejects.toThrow("OpenRouter returned an empty response. Try again.")

    const malformed: typeof fetch = async () =>
      jsonResponse({ choices: [{ message: { content: "not json" } }] })
    await expect(
      requestStructuredCompletion(completionInput(malformed))
    ).rejects.toThrow(
      "OpenRouter returned a response that was not valid JSON. Try again or switch models."
    )
  })

  it("wraps network failures in a friendly message", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed")
    }

    await expect(
      requestStructuredCompletion(completionInput(fetchImpl))
    ).rejects.toThrow(
      "Could not reach OpenRouter. Check your network connection and try again."
    )
  })
})

describe("hashContent", () => {
  it("is stable for identical input and differs for different input", async () => {
    const first = await hashContent("same input")
    const second = await hashContent("same input")
    const other = await hashContent("different input")

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(other)
  })
})
