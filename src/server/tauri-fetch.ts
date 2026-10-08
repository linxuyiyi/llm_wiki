import { fetch } from '@/web/tauri-http'
export async function getHttpFetch() { return fetch }
export function isFetchNetworkError(error: unknown) {
  return error instanceof TypeError
}
