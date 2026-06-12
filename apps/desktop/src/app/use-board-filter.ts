import { useSyncExternalStore } from "react"

/**
 * The board filter is the app-wide scope contract: the GitHub review query
 * the user applies on the inbox defines which pull requests are "on the
 * board", and every surface — the inbox lanes, the insights projections,
 * anything that feeds an AI prompt — must derive its universe from this
 * filter (see CLAUDE.md). Read the inbox through useBoardInbox, never
 * through an unfiltered read of the local store.
 *
 * The applied query lives in localStorage plus this module-level store, so
 * an apply on the inbox is visible to every mounted surface immediately.
 */

const storageKey = "pr-tracker:github-review-query:v1"
const listeners = new Set<() => void>()
let appliedQuery: string | undefined

function readStoredQuery(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(storageKey) ?? ""
}

export function getBoardFilterQuery(): string {
  appliedQuery ??= readStoredQuery()
  return appliedQuery
}

export function setBoardFilterQuery(query: string): void {
  const next = query.trim()
  if (next === getBoardFilterQuery()) return
  appliedQuery = next
  window.localStorage.setItem(storageKey, next)
  for (const listener of listeners) listener()
}

export function useBoardFilterQuery(): string {
  return useSyncExternalStore(subscribe, getBoardFilterQuery)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
