import type { WikiProject } from '@/types/wiki'
import { refreshProjectFileTree } from '@/lib/project-file-tree-refresh'
export const isWebRuntime = import.meta.env.VITE_LLM_WIKI_RUNTIME === 'web'
async function runOnServer(project: WikiProject, path: string, action: "scan" | "ingest"): Promise<string> {
  const route = action === "scan" ? "scheduled-import/scan" : "sources/ingest"
  const response = await fetch(`/api/web/projects/${encodeURIComponent(project.id)}/${route}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path}),
  })
  const submitted = await response.json()
  if (!response.ok || !submitted.ok) throw new Error(submitted.error || '扫描启动失败')
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const result = await fetch(submitted.statusUrl)
    const payload = await result.json()
    if (!result.ok || !payload.ok) throw new Error(payload.error || '扫描状态查询失败')
    if (payload.job.status === 'failed') throw new Error(payload.job.error || '扫描失败')
    if (payload.job.status === 'succeeded') {
      await refreshProjectFileTree(project.path, {projectId: project.id, bumpDataVersion: true})
      return payload.job.id
    }
  }
}

export async function scanOnServer(project: WikiProject, path: string): Promise<void> {
  await runOnServer(project, path, "scan")
}
export async function ingestOnServer(project: WikiProject, paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(path => runOnServer(project, path.startsWith(`${project.path}/`) ? path.slice(project.path.length + 1) : path, "ingest")))
}
