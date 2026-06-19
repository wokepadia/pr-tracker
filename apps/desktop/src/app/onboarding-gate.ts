export function shouldRedirectToOnboarding(input: {
  pathname: string
  tokenConfigured: boolean
  isLoading: boolean
}): boolean {
  if (input.isLoading) return false
  if (input.tokenConfigured) return false
  if (input.pathname === "/onboarding" || input.pathname === "/settings") {
    return false
  }

  return true
}
