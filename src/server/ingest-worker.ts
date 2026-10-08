import { useWikiStore } from '@/stores/wiki-store'
import { load } from '@/web/tauri-store'
import { loadSourceWatchConfig, loadOutputLanguage, loadProjectLlmOverride } from '@/lib/project-store'
import { resolveProjectLlmConfig, getTaskLlmConfig } from '@/lib/llm-task-routing'
import { hasUsableLlm } from '@/lib/has-usable-llm'
import { enqueueSourceIngest } from '@/lib/source-lifecycle'
import { scanAndImport } from '@/lib/scheduled-import'
import { writtenFiles } from './ingest-queue'
import type { WikiProject } from '@/types/wiki'

const nativeFetch = globalThis.fetch
process.on('message', async (input: {backend: string; project: WikiProject; action: string; path: string}) => {
  globalThis.fetch = (url, init) => nativeFetch(typeof url === 'string' && url.startsWith('/') ? new URL(url, input.backend) : url, init)
  try {
    const store = await load('app-state.json')
    const persisted = Object.fromEntries(await store.entries())
    const defaults = useWikiStore.getState()
    const override = await loadProjectLlmOverride(input.project.id)
    const globalConfig = persisted.llmConfig as typeof defaults.llmConfig ?? defaults.llmConfig
    const providers = persisted.providerConfigs as typeof defaults.providerConfigs ?? {}
    const custom = persisted.customLlmPresets as typeof defaults.customLlmPresets ?? []
    const llmConfig = resolveProjectLlmConfig(globalConfig, providers, override, custom)
    useWikiStore.setState({
      project: input.project, llmConfig, globalLlmConfig: globalConfig,
      providerConfigs: providers, customLlmPresets: custom, projectLlmOverride: override,
      taskModelRouting: persisted.taskModelRouting as typeof defaults.taskModelRouting ?? defaults.taskModelRouting,
      sourceWatchConfig: await loadSourceWatchConfig(input.project.id),
      outputLanguage: await loadOutputLanguage(input.project.id) ?? 'auto',
      mineruConfig: {...defaults.mineruConfig, ...persisted.mineruConfig as object},
      multimodalConfig: {...defaults.multimodalConfig, ...persisted.multimodalConfig as object},
      embeddingConfig: {...defaults.embeddingConfig, ...persisted.embeddingConfig as object},
      proxyConfig: {...defaults.proxyConfig, ...persisted.proxyConfig as object},
    })
    const model = getTaskLlmConfig('ingest')
    if (!hasUsableLlm(model) || !model.model.trim()) throw new Error('请先配置可用的摄取模型')
    if (input.action === 'scan') {
      await scanAndImport(input.project, input.path, { strict: true })
    } else {
      const ids = await enqueueSourceIngest(input.project, [`${input.project.path}/${input.path}`], llmConfig)
      if (!ids.length) throw new Error('文件类型不支持摄取，或文件被资料过滤规则排除')
    }
    process.send?.({ok: true, filesWritten: [...writtenFiles]})
  } catch (error) {
    process.send?.({ok: false, error: error instanceof Error ? error.message : String(error)})
  } finally {
    process.disconnect?.()
  }
})

// Stop an in-flight worker when the gateway is shut down. The journal
// retains its running job so restart retries through the native cache.
process.on("disconnect", () => process.exit(0))
