// The headless worker runs one project at a time. Reuse the native pipeline
// without taking ownership of the browser's persisted ingest queue.
import { autoIngest } from '@/lib/ingest'
import { useWikiStore } from '@/stores/wiki-store'
import { getTaskLlmConfig } from '@/lib/llm-task-routing'
import { fileExists } from '@/commands/fs'
export const writtenFiles = new Set<string>()
export async function enqueueBatch(projectId: string, files: Array<{sourcePath: string; folderContext: string}>) {
  const project = useWikiStore.getState().project
  if (!project || project.id !== projectId) throw new Error('Wrong ingest project')
  const ids: string[] = []
  for (const file of files) {
    const generated = await autoIngest(project.path, file.sourcePath, getTaskLlmConfig('ingest'), undefined, file.folderContext)
    const pages = generated.filter(path => path.startsWith('wiki/') && path.endsWith('.md'))
    if (!pages.length) throw new Error(`No Wiki pages generated for ${file.sourcePath}`)
    for (const path of pages) {
      if (!await fileExists(`${project.path}/${path}`)) throw new Error(`Generated Wiki file is missing: ${path}`)
      writtenFiles.add(path)
    }
    ids.push(file.sourcePath)
  }
  return ids
}
export async function enqueueInactiveProjectBatch(projectId: string, _projectPath: string, files: Array<{sourcePath: string; folderContext: string}>) {
  return enqueueBatch(projectId, files)
}
export async function discardTasksForSources(_paths: readonly string[]) { return 0 }
