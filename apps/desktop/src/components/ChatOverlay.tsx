import { useMemo, useRef, useState } from "react"
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type TextMessagePartComponent,
  type ThreadMessage,
} from "@assistant-ui/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, MessageSquare, Plus, Send, Sparkles, X } from "lucide-react"
import {
  clearChatThread,
  getChatThread,
  sendChatMessage,
  type ChatThreadState,
} from "@/api"
import type { AiDashboardInput } from "@/ai/ai-dashboard"
import { MarkdownContent } from "@/components/MarkdownContent"

/**
 * The dashboard chat overlay. A floating launcher opens a docked chat panel
 * whose conversation is grounded strictly in the applied board's pull requests
 * (the same `dashboardInput` projection the dashboard renders) and persisted in
 * SQLite. The chat library (assistant-ui) owns the message-list and composer
 * UI; the model call and persistence run through the board-scoped bridge.
 */
export function DashboardChat({
  boardFingerprint,
  dashboardInput,
}: {
  boardFingerprint: string
  dashboardInput: AiDashboardInput
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {open ? (
        <ChatPanel
          boardFingerprint={boardFingerprint}
          dashboardInput={dashboardInput}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background shadow-lg transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open the board chat"
        >
          <MessageSquare className="h-4 w-4" />
          Ask about your board
        </button>
      )}
    </>
  )
}

function ChatPanel({
  boardFingerprint,
  dashboardInput,
  onClose,
}: {
  boardFingerprint: string
  dashboardInput: AiDashboardInput
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const threadQuery = useQuery({
    queryKey: ["chat-thread", boardFingerprint],
    queryFn: () => getChatThread(boardFingerprint),
    refetchOnWindowFocus: false,
    staleTime: 0,
  })
  const clearMutation = useMutation({
    mutationFn: () => clearChatThread(boardFingerprint),
    onSuccess: (state) => {
      queryClient.setQueryData(["chat-thread", boardFingerprint], state)
    },
  })

  const thread = threadQuery.data

  return (
    <div className="fixed bottom-6 right-6 z-40 flex h-[600px] max-h-[calc(100vh-48px)] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <h2 className="text-sm font-semibold text-foreground">Board chat</h2>
          <span className="text-xs text-muted-foreground">
            grounded in your filtered cards
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Start a new chat"
            title="Start a new chat"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close chat"
            title="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {threadQuery.isLoading || !thread ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading conversation…
        </div>
      ) : (
        <ChatConversation
          key={`${boardFingerprint}::${thread.threadId || "new"}::${thread.messages.length}`}
          boardFingerprint={boardFingerprint}
          dashboardInput={dashboardInput}
          initial={thread}
        />
      )}
    </div>
  )
}

function ChatConversation({
  boardFingerprint,
  dashboardInput,
  initial,
}: {
  boardFingerprint: string
  dashboardInput: AiDashboardInput
  initial: ChatThreadState
}) {
  // The thread id and the live board projection are read fresh on every send
  // without recreating the runtime, so the answer is always grounded in the
  // current board and appended to the right conversation.
  const threadIdRef = useRef(initial.threadId)
  const dashboardRef = useRef(dashboardInput)
  dashboardRef.current = dashboardInput

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async run({ messages }) {
        const message = lastUserText(messages)
        if (!message) {
          throw new Error("Type a question to ask about your board.")
        }
        const result = await sendChatMessage({
          threadId: threadIdRef.current,
          boardFingerprint,
          message,
          dashboardInput: dashboardRef.current,
        })
        threadIdRef.current = result.threadId
        return {
          content: [{ type: "text", text: result.assistantMessage.content }],
        }
      },
    }),
    [boardFingerprint]
  )

  const runtime = useLocalRuntime(adapter, {
    initialMessages: initial.messages.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Empty>
            <EmptyState />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />
          <ThreadPrimitive.If running>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>
        <Composer />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

function EmptyState() {
  return (
    <div className="grid place-items-center px-4 py-10 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <MessageSquare className="h-5 w-5" />
      </div>
      <p className="max-w-xs text-sm leading-6 text-muted-foreground">
        Ask anything about the pull requests on your applied board — which need
        you, what changed, who&apos;s blocking whom. Answers come only from your
        board&apos;s data.
      </p>
    </div>
  )
}

const MessageText: TextMessagePartComponent = ({ text }) => (
  <MarkdownContent source={text} className="text-sm leading-6" />
)

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-foreground px-3.5 py-2 text-sm leading-6 text-background">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-border bg-background px-3.5 py-2 text-foreground">
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
        <MessagePrimitive.Error>
          <div className="mt-1 text-xs text-destructive">
            Something went wrong. Try again.
          </div>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  )
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 border-t border-border bg-card px-3 py-3">
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        placeholder="Ask about your board…"
        className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <ComposerPrimitive.Send
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition hover:opacity-90 disabled:opacity-40"
        aria-label="Send"
      >
        <Send className="h-4 w-4" />
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  )
}

function lastUserText(messages: readonly ThreadMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") {
      return message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
    }
  }
  return ""
}
