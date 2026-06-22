import { clsx, type ClassValue } from "clsx"
import { isTauri } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import type { MouseEvent } from "react"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// In a Tauri webview, `target="_blank"` does not hand the URL to the
// system browser, so external links would otherwise do nothing. Intercept
// the click and open it through the opener plugin when running in Tauri,
// while leaving the normal anchor behavior intact in the browser preview.
function handleExternalLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  if (!isTauri()) return

  const href = event.currentTarget.href
  if (!href) return

  event.preventDefault()
  void openUrl(href)
}

export const externalLinkProps = {
  target: "_blank",
  rel: "noopener noreferrer",
  onClick: handleExternalLinkClick,
} as const
