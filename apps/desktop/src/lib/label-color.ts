import type { CSSProperties } from "react"

/**
 * Inline style for a GitHub label chip that reproduces the label's own
 * color: a solid background in the label color with readable text picked by
 * luminance, exactly as GitHub renders it. Returns undefined when no valid
 * 6-digit hex color is available so callers can fall back to neutral chip
 * classes.
 */
export function githubLabelStyle(
  color: string | undefined
): CSSProperties | undefined {
  if (!color) return undefined

  const normalized = color.replace(/^#/, "")
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return undefined

  const backgroundColor = `#${normalized}`
  return {
    backgroundColor,
    borderColor: backgroundColor,
    color: githubLabelTextColor(normalized),
  }
}

function githubLabelTextColor(color: string): string {
  const red = Number.parseInt(color.slice(0, 2), 16)
  const green = Number.parseInt(color.slice(2, 4), 16)
  const blue = Number.parseInt(color.slice(4, 6), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return luminance > 0.58 ? "#24292f" : "#ffffff"
}
