import { fork } from 'node:child_process'
import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type Project = {id: string; path: string; name: string}
export type IngestJob = {
  id: string; project: Project; action: 'ingest' | 'scan'; path: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  createdAt: number; updatedAt: number; filesWritten: string[]; error?: string; sourceHash?: string
}

export class IngestService {
  private jobs: IngestJob[] = []
  private journal = ''
  private running = false
  private writeTail = Promise.resolve()
  private sweepRunning = false
  constructor(private readonly backend: string) {}

  async api(path: string, body?: unknown): Promise<Record<string, any>> {
    const response = await fetch(new URL(path, this.backend), body === undefined ? undefined : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    })
    const payload = await response.json() as Record<string, any>
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
    return payload
  }
  async settings(): Promise<Record<string, any>> {
    const response = await this.api('/api/web/store', {name: 'app-state.json', op: 'entries', defaults: {}})
    return Object.fromEntries(response.result)
  }
  async initialize() {
    const info = await this.api('/api/web/info')
    this.journal = resolve(info.result.dataDir, 'web-ingest-jobs.json')
    try {
      this.jobs = JSON.parse(await readFile(this.journal, 'utf8')) as IngestJob[]
      for (const job of this.jobs) if (job.status === 'running') job.status = 'pending'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.persist()
    void this.drain()
  }
  private async persist() {
    const snapshot = JSON.stringify(this.jobs, null, 2)
    const write = this.writeTail.then(async () => {
      await writeFile(`${this.journal}.tmp`, snapshot)
      await rename(`${this.journal}.tmp`, this.journal)
    })
    this.writeTail = write.catch(() => {})
    await write
  }
  async project(id: string): Promise<Project> {
    const payload = await this.api('/api/v1/projects')
    const project = id === 'current' ? payload.currentProject : payload.projects.find((p: Project) => p.id === id)
    if (!project || typeof project.path !== 'string') throw new Error('项目不存在')
    return project
  }
  async sourcePath(project: Project, input: string): Promise<string> {
    const path = input.replaceAll('\\', '/')
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '..' || part.startsWith('.'))) {
      throw new Error('资料路径必须是 raw/sources 下的相对路径')
    }
    const rel = path.startsWith('raw/sources/') ? path : `raw/sources/${path}`
    const root = await realpath(resolve(project.path, 'raw/sources'))
    const target = await realpath(resolve(project.path, rel))
    if (!target.startsWith(`${root}${sep}`)) throw new Error('资料路径越界')
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error('资料不是文件')
    if (metadata.size > 100 * 1024 * 1024) throw new Error('单文件不能超过 100 MiB')
    return rel
  }
  async submit(project: Project, action: 'ingest' | 'scan', path: string): Promise<IngestJob> {
    const canonical = await this.project(project.id)
    const normalized = action === 'ingest' ? await this.sourcePath(canonical, path) : path.trim()
    if (!normalized) throw new Error('目录或文件路径不能为空')
    const sourceHash = action === 'ingest' ? createHash('sha256').update(await readFile(resolve(canonical.path, normalized))).digest('hex') : undefined
    const existing = this.jobs.find(job => job.project.id === canonical.id && job.action === action && job.path === normalized && job.sourceHash === sourceHash && ['pending', 'running'].includes(job.status))
    if (existing) return existing
    const job: IngestJob = {id: randomUUID(), project: canonical, action, path: normalized, sourceHash, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), filesWritten: []}
    this.jobs.push(job)
    // Keep all unfinished work and a bounded history of terminal jobs.
    const finished = this.jobs.filter(job => ['succeeded', 'failed'].includes(job.status)).slice(-500)
    this.jobs = [...finished, ...this.jobs.filter(job => ['pending', 'running'].includes(job.status))]
    await this.persist()
    void this.drain()
    return job
  }
  find(id: string) { return this.jobs.find(job => job.id === id) }
  private run(job: IngestJob): Promise<{ok: boolean; filesWritten?: string[]; error?: string}> {
    return new Promise((resolveResult, reject) => {
      const child = fork(fileURLToPath(new URL('./ingest-worker.cjs', import.meta.url)), [], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']})
      let settled = false
      const timeout = setTimeout(() => { child.kill(); reject(new Error('摄取超时，请检查模型服务和资料解析日志')) }, 2 * 60 * 60 * 1000)
      child.on('message', (result) => { settled = true; clearTimeout(timeout); resolveResult(result as {ok: boolean; filesWritten?: string[]; error?: string}); child.kill() })
      child.on('error', error => { clearTimeout(timeout); reject(error) })
      child.on('exit', code => { clearTimeout(timeout); if (!settled) reject(new Error(`摄取进程退出 (${code})`)) })
      child.send({backend: this.backend, project: job.project, action: job.action, path: job.path})
    })
  }
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const job = this.jobs.find(job => job.status === 'pending')
        if (!job) break
        job.status = 'running'; job.updatedAt = Date.now()
        await this.persist()
        try {
          // Revalidate recovered jobs before allowing filesystem operations.
          job.project = await this.project(job.project.id)
          if (job.action === 'ingest') await this.sourcePath(job.project, job.path)
          const result = await this.run(job)
          if (!result.ok) throw new Error(result.error || '摄取失败')
          job.status = 'succeeded'; job.filesWritten = result.filesWritten ?? []
        } catch (error) {
          job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error)
          console.error(`[web-ingest] ${job.action} ${job.project.id}: ${job.error}`)
        }
        job.updatedAt = Date.now()
        await this.persist()
      }
    } catch (error) { console.error('[web-ingest] journal error:', error) }
    finally { this.running = false }
  }
  async sweep() {
    if (this.sweepRunning) return
    this.sweepRunning = true
    try {
      const settings = await this.settings()
      const projects = (await this.api('/api/v1/projects')).projects as Project[]
      for (const project of projects) {
        const config = settings[`scheduledImportConfig:${project.path.replaceAll('\\', '/')}`]
        if (!config?.enabled || !config.path || !Number.isFinite(config.interval) || config.interval <= 0) continue
        if (config.lastScan && Date.now() - config.lastScan < config.interval * 60000) continue
        // Failed jobs respect the interval, while lastScan means a successful scan.
        const last = [...this.jobs].reverse().find(job => job.project.id === project.id && job.action === 'scan' && job.path === config.path)
        if (last?.status === 'failed' && Date.now() - last.updatedAt < config.interval * 60000) continue
        await this.submit(project, 'scan', config.path)
      }
    } catch (error) { console.error('[web-ingest] schedule:', error instanceof Error ? error.message : error) }
    finally { this.sweepRunning = false }
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const upload = req.method === 'PUT' && url.searchParams.get('ingest') === 'true'
      ? url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/sources\/file$/) : null
    const ingest = url.pathname.match(/^\/api\/(v1|web)\/projects\/([^/]+)\/sources\/ingest$/)
    const scan = url.pathname.match(/^\/api\/(v1|web)\/projects\/([^/]+)\/scheduled-import\/scan$/)
    const jobRoute = url.pathname.match(/^\/api\/(v1|web)\/ingest-jobs\/([^/]+)$/)
    if (!ingest && !scan && !jobRoute && !upload) return false
    const isPublic = Boolean(upload) || (ingest ?? scan ?? jobRoute)![1] === 'v1'
    try {
      if (isPublic) {
        const settings = await this.settings()
        const token = (process.env.LLM_WIKI_API_TOKEN || settings.apiConfig?.token || process.env.LLM_WIKI_MCP_AUTH_TOKEN || '').trim()
        const supplied = req.headers.authorization?.replace(/^Bearer /i, '') ?? ''
        if (!token || Buffer.byteLength(token) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))) {
          this.respond(res, 401, {ok: false, error: 'Unauthorized'}); return true
        }
      }
      if (upload) {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 140 * 1024 * 1024) throw new Error('单文件请求过大')
          chunks.push(Buffer.from(chunk))
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {path?: string}
        if (typeof body.path !== 'string') throw new Error('path 为必填字符串')
        const project = await this.project(decodeURIComponent(upload[1]))
        const text = (body as {content?: unknown}).content
        const encoded = (body as {contentBase64?: unknown}).contentBase64
        const bytes = typeof text === 'string' ? Buffer.byteLength(text) : typeof encoded === 'string' ? Buffer.from(encoded, 'base64').length : 0
        if (bytes > 100 * 1024 * 1024) throw new Error('单文件不能超过 100 MiB')
        // Validate missing paths and symlink ancestors before the existing
        // backend API writes the upload.
        const path = body.path.replaceAll('\\', '/')
        if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part.startsWith('.'))) throw new Error('资料路径不安全')
        const rel = path.startsWith('raw/sources/') ? path : `raw/sources/${path}`
        const root = await realpath(resolve(project.path, 'raw/sources'))
        let ancestor = resolve(project.path, rel)
        for (;;) {
          try {
            const actual = await realpath(ancestor)
            if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error('资料路径越界')
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            const parent = resolve(ancestor, '..')
            if (parent === ancestor) throw error
            ancestor = parent
          }
        }
        const response = await fetch(new URL(url.pathname, this.backend), {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
        const written = await response.json() as Record<string, any>
        if (!response.ok || !written.ok) throw new Error(written.error || '资料上传失败')
        const job = await this.submit(project, 'ingest', body.path)
        this.respond(res, 202, {...written, job, statusUrl: `/api/v1/ingest-jobs/${job.id}`})
      } else if (jobRoute && req.method === 'GET') {
        const job = this.find(jobRoute[2])
        this.respond(res, job ? 200 : 404, job ? {ok: true, job} : {ok: false, error: '任务不存在'})
      } else if ((ingest || scan) && req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw new Error('请求体过大') }
        const body = JSON.parse(raw || '{}') as {path?: string}
        if (typeof body.path !== 'string') throw new Error('path 为必填字符串')
        const project = await this.project(decodeURIComponent((ingest ?? scan)![2]))
        const job = await this.submit(project, ingest ? 'ingest' : 'scan', body.path)
        this.respond(res, 202, {ok: true, job, statusUrl: `/api/${isPublic ? 'v1' : 'web'}/ingest-jobs/${job.id}`})
      } else this.respond(res, 405, {ok: false, error: 'Method not allowed'})
    } catch (error) { this.respond(res, 400, {ok: false, error: error instanceof Error ? error.message : String(error)}) }
    return true
  }
  private respond(res: ServerResponse, status: number, payload: unknown) {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload))
  }
}
