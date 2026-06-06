import { describe, expect, it } from "vitest"
import { shouldRedirectToOnboarding } from "./onboarding-gate"

describe("onboarding route gate", () => {
  it("redirects fresh users from app routes", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        onboardingComplete: false,
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(true)
  })

  it("does not redirect while settings are loading", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        onboardingComplete: false,
        tokenConfigured: false,
        isLoading: true,
      })
    ).toBe(false)
  })

  it("allows configured or completed users into the app", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        onboardingComplete: false,
        tokenConfigured: true,
        isLoading: false,
      })
    ).toBe(false)
    expect(
      shouldRedirectToOnboarding({
        pathname: "/",
        onboardingComplete: true,
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(false)
  })

  it("keeps onboarding and settings reachable for first-run recovery", () => {
    expect(
      shouldRedirectToOnboarding({
        pathname: "/onboarding",
        onboardingComplete: false,
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(false)
    expect(
      shouldRedirectToOnboarding({
        pathname: "/settings",
        onboardingComplete: false,
        tokenConfigured: false,
        isLoading: false,
      })
    ).toBe(false)
  })
})
