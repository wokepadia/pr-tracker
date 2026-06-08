import reviewNinjaLogoUrl from "@/assets/review-ninja-logo.png"
import { cn } from "@/lib/utils"

export function AppLogo({
  className,
  label = "Review Ninja",
  showLabel = true,
}: {
  className?: string
  label?: string
  showLabel?: boolean
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <img
        alt=""
        className="h-5 w-5 rounded-[4px]"
        height={20}
        src={reviewNinjaLogoUrl}
        width={20}
      />
      {showLabel ? <span>{label}</span> : null}
    </span>
  )
}
