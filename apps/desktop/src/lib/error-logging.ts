import { error } from "@tauri-apps/plugin-log"

let hasInstalledRendererErrorLogging = false

export function installRendererErrorLogging(): void {
  if (hasInstalledRendererErrorLogging || typeof window === "undefined") return
  hasInstalledRendererErrorLogging = true

  window.addEventListener("error", (event) => {
    void logRendererError("renderer error", event.error ?? event.message)
  })

  window.addEventListener("unhandledrejection", (event) => {
    void logRendererError("unhandled promise rejection", event.reason)
  })
}

export async function logRendererError(context: string, value: unknown): Promise<void> {
  try {
    await error(`${context}: ${formatLoggableError(value)}`)
  } catch {
    // The Tauri log API is unavailable in browser-only dev mode.
  }
}

function formatLoggableError(value: unknown): string {
  if (value instanceof Error) {
    return [value.name, value.message, value.stack]
      .filter((part) => part && part.trim().length > 0)
      .join("\n")
  }

  if (typeof value === "string") return value
  if (value === null) return "null"
  if (typeof value === "undefined") return "undefined"

  return Object.prototype.toString.call(value)
}
