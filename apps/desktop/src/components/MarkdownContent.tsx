import ReactMarkdown, { type Components } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import { cn, externalLinkProps } from "@/lib/utils"

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "alt",
      "height",
      "src",
      "title",
      "width",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...new Set([...(defaultSchema.protocols?.src ?? []), "http", "https"])],
  },
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "img"])],
}

const markdownComponents: Components = {
  a({ href, children }) {
    const isExternal = href ? /^https?:\/\//i.test(href) : false

    return (
      <a
        href={href}
        className="font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground"
        {...(isExternal ? externalLinkProps : {})}
      >
        {children}
      </a>
    )
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    )
  },
  code({ children }) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground">
        {children}
      </code>
    )
  },
  h1({ children }) {
    return <h3 className="text-base font-semibold text-foreground">{children}</h3>
  },
  h2({ children }) {
    return <h3 className="text-base font-semibold text-foreground">{children}</h3>
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold text-foreground">{children}</h3>
  },
  hr() {
    return <div className="h-px bg-border" />
  },
  img({ src, alt, title }) {
    if (!src) return null

    return (
      <img
        src={src}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="max-h-[520px] max-w-full rounded-md border border-border bg-muted/20 object-contain"
      />
    )
  },
  ol({ children }) {
    return <ol className="list-decimal space-y-1 pl-5">{children}</ol>
  },
  p({ children }) {
    return <p>{children}</p>
  },
  pre({ children }) {
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-5">
        {children}
      </pre>
    )
  },
  ul({ children }) {
    return <ul className="list-disc space-y-1 pl-5">{children}</ul>
  },
}

export function MarkdownContent({
  source,
  compact,
  className,
}: {
  source: string
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-6 text-foreground",
        compact && "max-h-[220px] overflow-hidden",
        className
      )}
    >
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
