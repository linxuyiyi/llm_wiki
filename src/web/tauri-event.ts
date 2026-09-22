import { addWebEventListener, type WebRuntimeEvent } from "./event-bus"

export type UnlistenFn = () => void
export type Event<T> = WebRuntimeEvent<T>

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return addWebEventListener(event, handler)
}
