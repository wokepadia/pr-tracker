/**
 * Minimal OpenRouter chat-completions client. Every AI feature goes through
 * `requestStructuredCompletion`, which forces a JSON-schema response so the
 * UI only ever renders validated, structured output. Calls are made directly
 * from the user's machine to OpenRouter with the user's own key — there is
 * no intermediary service.
 */

const openRouterCompletionsUrl =
  "https://openrouter.ai/api/v1/chat/completions"

export interface StructuredCompletionInput {
  apiKey: string
  model: string
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

interface OpenRouterCompletionPayload {
  choices?: Array<{ message?: { content?: string | null } }>
  error?: { message?: string }
}

export async function requestStructuredCompletion<T>(
  input: StructuredCompletionInput
): Promise<T> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(openRouterCompletionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Review Ninja",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
      }),
    })
  } catch {
    throw new Error(
      "Could not reach OpenRouter. Check your network connection and try again."
    )
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const payload = (await response.json()) as OpenRouterCompletionPayload
  // OpenRouter can return 200 with an error body when the upstream provider
  // fails mid-request.
  if (payload.error?.message) {
    throw new Error(`OpenRouter error: ${payload.error.message}`)
  }

  const content = payload.choices?.[0]?.message?.content
  if (!content) {
    throw new Error("OpenRouter returned an empty response. Try again.")
  }

  try {
    return JSON.parse(content) as T
  } catch {
    throw new Error(
      "OpenRouter returned a response that was not valid JSON. Try again or switch models."
    )
  }
}

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface OpenRouterChatInput {
  apiKey: string
  model: string
  system: string
  messages: ChatTurn[]
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Free-form (non-structured) multi-turn chat completion. Unlike
 * `requestStructuredCompletion`, this returns the assistant's plain text so the
 * chat overlay can render a conversational answer. Grounding is the caller's
 * job: the board-scoped context is carried in the system prompt.
 */
export async function requestOpenRouterChat(
  input: OpenRouterChatInput
): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(openRouterCompletionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Review Ninja",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          ...input.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
      }),
    })
  } catch {
    throw new Error(
      "Could not reach OpenRouter. Check your network connection and try again."
    )
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const payload = (await response.json()) as OpenRouterCompletionPayload
  if (payload.error?.message) {
    throw new Error(`OpenRouter error: ${payload.error.message}`)
  }

  const content = payload.choices?.[0]?.message?.content
  if (!content || !content.trim()) {
    throw new Error("OpenRouter returned an empty response. Try again.")
  }

  return content.trim()
}

async function readErrorMessage(response: Response): Promise<string> {
  let detail: string | undefined
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    detail = body.error?.message
  } catch {
    // Non-JSON error body; fall through to the status-based message.
  }

  if (response.status === 401) {
    return "OpenRouter rejected the API key. Check the key in Settings."
  }
  if (response.status === 402) {
    return "OpenRouter reports insufficient credits on your account."
  }
  if (response.status === 429) {
    return "OpenRouter rate limit reached. Wait a moment and try again."
  }
  return detail
    ? `OpenRouter error: ${detail}`
    : `OpenRouter request failed with status ${response.status}.`
}
