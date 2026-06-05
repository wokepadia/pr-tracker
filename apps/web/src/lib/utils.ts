import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const externalLinkProps = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const

export function openExternalLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}
