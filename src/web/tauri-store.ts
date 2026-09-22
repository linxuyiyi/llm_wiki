type StoreValue = unknown

export interface StoreOptions {
  autoSave?: boolean
  defaults?: Record<string, StoreValue>
}

async function callStore<T>(
  name: string,
  op: string,
  key?: string,
  value?: StoreValue,
  defaults?: Record<string, StoreValue>,
): Promise<T> {
  const response = await fetch("/api/web/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, op, key, value, defaults }),
  })
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || "Web store request failed")
  return payload.result as T
}

class WebStore {
  constructor(private readonly name: string, private readonly defaults: Record<string, StoreValue> = {}) {}

  get<T>(key: string): Promise<T | null> {
    return callStore<T | null>(this.name, "get", key, undefined, this.defaults)
  }
  set(key: string, value: StoreValue): Promise<void> {
    return callStore<void>(this.name, "set", key, value, this.defaults)
  }
  delete(key: string): Promise<boolean> {
    return callStore<boolean>(this.name, "delete", key, undefined, this.defaults)
  }
  has(key: string): Promise<boolean> {
    return callStore<boolean>(this.name, "has", key, undefined, this.defaults)
  }
  keys(): Promise<string[]> {
    return callStore<string[]>(this.name, "keys", undefined, undefined, this.defaults)
  }
  values<T>(): Promise<T[]> {
    return callStore<T[]>(this.name, "values", undefined, undefined, this.defaults)
  }
  entries<T>(): Promise<[string, T][]> {
    return callStore<[string, T][]>(this.name, "entries", undefined, undefined, this.defaults)
  }
  clear(): Promise<void> {
    return callStore<void>(this.name, "clear", undefined, undefined, this.defaults)
  }
  save(): Promise<void> {
    return callStore<void>(this.name, "save", undefined, undefined, this.defaults)
  }
  reload(): Promise<void> {
    return Promise.resolve()
  }
  reset(): Promise<void> {
    return callStore<void>(this.name, "reset", undefined, undefined, this.defaults)
  }
}

export async function load(name: string, options: StoreOptions = {}): Promise<WebStore> {
  return new WebStore(name, options.defaults ?? {})
}
