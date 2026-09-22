export type UnlistenFn = () => void
export interface Event<T> { event: string; id: number; payload: T }

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  if (typeof EventSource === "undefined") return () => {}
  const source = new EventSource(`/api/web/events?event=${encodeURIComponent(event)}`)
  source.onmessage = (message) => {
    try {
      handler({ event, id: Number(message.lastEventId || 0), payload: JSON.parse(message.data) as T })
    } catch {
      // Ignore malformed/heartbeat messages.
    }
  }
  return () => source.close()
}
