import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

export function AuthorAvatar({
  login,
  avatarUrl,
  className,
}: {
  login: string
  avatarUrl?: string
  className?: string
}) {
  const [didImageFail, setDidImageFail] = useState(false)
  const initials = login.slice(0, 2).toUpperCase()

  useEffect(() => {
    setDidImageFail(false)
  }, [avatarUrl])

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-white text-xs text-muted-foreground",
        className
      )}
    >
      {avatarUrl && !didImageFail ? (
        <img
          src={avatarUrl}
          alt={`${login} avatar`}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setDidImageFail(true)}
        />
      ) : (
        initials
      )}
    </span>
  )
}
