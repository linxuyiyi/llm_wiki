interface OpenDialogOptions {
  multiple?: boolean
  directory?: boolean
  title?: string
  filters?: Array<{ name: string; extensions: string[] }>
}
interface SaveDialogOptions { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.onload = () => {
      const value = String(reader.result ?? "")
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value)
    }
    reader.readAsDataURL(file)
  })
}

async function uploadFiles(files: File[]): Promise<string[]> {
  const batchId = crypto.randomUUID()
  const uploaded: string[] = []
  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const response = await fetch("/api/web/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId,
        name: file.name,
        relativePath,
        contentBase64: await readAsBase64(file),
      }),
    })
    const payload = await response.json()
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || "Upload failed")
    uploaded.push(payload.result.path)
  }
  return uploaded
}

async function browserPickFiles(options: OpenDialogOptions): Promise<string[] | string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = options.multiple === true
    if (options.filters?.length) {
      input.accept = options.filters.flatMap((f) => f.extensions.map((ext) => `.${ext}`)).join(",")
    }
    input.style.display = "none"
    document.body.appendChild(input)
    input.addEventListener("change", async () => {
      try {
        const paths = await uploadFiles(Array.from(input.files ?? []))
        resolve(options.multiple ? paths : (paths[0] ?? null))
      } catch (err) {
        reject(err)
      } finally {
        input.remove()
      }
    }, { once: true })
    input.click()
  })
}

export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (options.directory) {
    const path = window.prompt(options.title || "Server directory path")
    return path?.trim() || null
  }
  return browserPickFiles(options)
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const path = window.prompt(options.title || "Server destination path", options.defaultPath || "")
  return path?.trim() || null
}

export async function message(messageText: string, options?: { title?: string }): Promise<void> {
  window.alert(options?.title ? `${options.title}\n\n${messageText}` : messageText)
}
export async function ask(messageText: string, options?: { title?: string }): Promise<boolean> {
  return window.confirm(options?.title ? `${options.title}\n\n${messageText}` : messageText)
}
export const confirm = ask
