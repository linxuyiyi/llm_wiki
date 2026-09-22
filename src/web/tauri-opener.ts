export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer")
}
export async function openPath(path: string): Promise<void> {
  const response = await fetch(`/api/web/file?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(`Unable to open server path: ${path}`)
}
export const revealItemInDir = openPath
