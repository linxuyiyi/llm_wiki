export interface WebRuntimeEvent<T = unknown> {
  event: string
  id: number
  payload: T
}

type EventHandler = (event: WebRuntimeEvent) => void

const handlers = new Map<string, Set<EventHandler>>()
let nextEventId = 1

export function addWebEventListener<T>(
  event: string,
  handler: (event: WebRuntimeEvent<T>) => void,
): () => void {
  const set = handlers.get(event) ?? new Set<EventHandler>()
  const wrapped = handler as EventHandler
  set.add(wrapped)
  handlers.set(event, set)
  return () => {
    set.delete(wrapped)
    if (set.size === 0) handlers.delete(event)
  }
}

export function emitWebEvent<T>(event: string, payload: T): void {
  const snapshot = [...(handlers.get(event) ?? [])]
  const message: WebRuntimeEvent<T> = {
    event,
    id: nextEventId++,
    payload,
  }
  for (const handler of snapshot) {
    try {
      handler(message)
    } catch (error) {
      console.error(`[web-runtime] event handler failed for ${event}:`, error)
    }
  }
}
