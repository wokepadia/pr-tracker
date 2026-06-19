import { describe, expect, it } from "vitest"
import { shouldRedirectToOnboarding } from "./onboarding-gate"

describe("onboarding route gate", () => {
  it("redirects fresh users from app routes", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(true)
  })

  it("does not redirect while settings are loading", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        tokenConfigured: false,
        isLoading: true,
      })
    ).toBe(false)
  })

  it("only lets users with a configured token into the app", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        tokenConfigured: true,
        isLoading: false,
      })
    ).toBe(false)
  })

  it("keeps onboarding and settings reachable for first-run recovery", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/onboarding",
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(false)
    expect(
      shouldRedirectToOnboarding({
        pathname: "/settings",
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(false)
  })
})
