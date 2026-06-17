import { describe, expect, it } from "vitest"
import { formatSyncStatusLabel } from "./sync-status"

describe("sync status label", () => {
  const now = Date.parse("2026-06-17T12:00:00.000Z")

  it("reports an active sync first", () => {
    expect(
      formatSyncStatusLabel({
        isSyncing: true,
        tokenConfigured: true,
        lastSyncedAt: "2026-06-17T11:59:00.000Z",
        now,
      })
    ).toBe("syncing with GitHub…")
  })

  it("labels local-only data when no token is configured", () => {
    expect(
      formatSyncStatusLabel({ isSyncing: false, tokenConfigured: false, now })
    ).toBe("local data only")
  })

  it("reports when a configured board has never synced", () => {
    expect(
      formatSyncStatusLabel({ isSyncing: false, tokenConfigured: true, now })
    ).toBe("not synced yet")
  })

  it("formats the elapsed time since the last sync", () => {
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        tokenConfigured: true,
        lastSyncedAt: "2026-06-17T11:59:40.000Z",
        now,
      })
    ).toBe("synced just now")
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        tokenConfigured: true,
        lastSyncedAt: "2026-06-17T11:30:00.000Z",
        now,
      })
    ).toBe("synced 30m ago")
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        tokenConfigured: true,
        lastSyncedAt: "2026-06-17T09:00:00.000Z",
        now,
      })
    ).toBe("synced 3h ago")
    expect(
      formatSyncStatusLabel({
        isSyncing: false,
        tokenConfigured: true,
        lastSyncedAt: "2026-06-15T12:00:00.000Z",
        now,
      })
    ).toBe("synced 2d ago")
  })
})
