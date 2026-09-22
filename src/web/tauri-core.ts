export interface InvokeArgs { [key: string]: unknown }

export function isTauri(): boolean {
  return false
}

export function convertFileSrc(filePath: string): string {
  return `/api/web/file?path=${encodeURIComponent(filePath)}`
}

export async function invoke<T>(command: string, args: InvokeArgs = {}): Promise<T> {
  const response = await fetch("/api/web/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Web runtime command failed: ${command}`)
  }
  return payload.result as T
}
