/**
 * Stable content hash used as the AI cache key: a generated summary is
 * reused as long as the exact input it was generated from is unchanged.
 */
export async function hashContent(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
