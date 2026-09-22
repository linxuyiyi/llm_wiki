function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const fetch: typeof globalThis.fetch = async (input, init) => {
  const pluginInit = init as (RequestInit & { danger?: { acceptInvalidCerts?: boolean } }) | undefined
  const request = input instanceof Request ? input : new Request(input, init)
  const bodyBytes = request.method === "GET" || request.method === "HEAD"
    ? null
    : new Uint8Array(await request.clone().arrayBuffer())
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => { headers[key] = value })
  const response = await globalThis.fetch("/api/web/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: request.url,
      method: request.method,
      headers,
      bodyBase64: bodyBytes ? bytesToBase64(bodyBytes) : null,
      acceptInvalidCerts: pluginInit?.danger?.acceptInvalidCerts === true,
    }),
    signal: init?.signal,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) throw new TypeError(payload?.error || "Failed to fetch")
  const responseBytes = base64ToBytes(payload.result.bodyBase64 || "")
  const responseBody = responseBytes.buffer.slice(
    responseBytes.byteOffset,
    responseBytes.byteOffset + responseBytes.byteLength,
  ) as ArrayBuffer
  return new Response(responseBody, {
    status: payload.result.status,
    statusText: payload.result.statusText || "",
    headers: payload.result.headers || {},
  })
}
