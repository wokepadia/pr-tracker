import { describe, expect, it } from "vitest"
import { describeGithubSyncError } from "./sync-error"

function githubApiError(status: number, statusText: string): Error {
  const error = new Error(
    `GitHub API request failed: ${status} ${statusText}`
  ) as Error & { status?: number }
  error.status = status
  return error
}

describe("describeGithubSyncError", () => {
  it("classifies rejected tokens as auth errors with a settings link", () => {
    const view = describeGithubSyncError(githubApiError(401, "Unauthorized"))
    expect(view.kind).toBe("auth")
    expect(view.showSettingsLink).toBe(true)
  })

  it("classifies rate limits and permission denials together", () => {
    expect(describeGithubSyncError(githubApiError(403, "Forbidden")).kind).toBe(
      "forbidden"
    )
    expect(describeGithubSyncError(githubApiError(429, "Too Many Requests")).kind).toBe(
      "forbidden"
    )
  })

  it("classifies timeouts and fetch failures as network errors", () => {
    expect(
      describeGithubSyncError(
        new Error("GitHub API request timed out for /repos")
      ).kind
    ).toBe("network")
    expect(describeGithubSyncError(new TypeError("Failed to fetch")).kind).toBe(
      "network"
    )
  })

  it("links to settings when an unknown error mentions the token", () => {
    const view = describeGithubSyncError(
      new Error(
        "GitHub settings are saved, but the Stronghold token is missing. Re-enter your GitHub token in Settings."
      )
    )
    expect(view.kind).toBe("unknown")
    expect(view.showSettingsLink).toBe(true)
    expect(view.message).toContain("Stronghold")
  })

  it("falls back to a generic message for empty errors", () => {
    const view = describeGithubSyncError(undefined)
    expect(view.kind).toBe("unknown")
    expect(view.message).toContain("unknown reason")
  })
})
