import { join } from 'path'
import { Worker } from 'worker_threads'
import { app, BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService, type ChatSession } from './chatService'
import { SemanticChunker } from './semantic/chunker'
import {
  getSemanticIndexPath,
  readInstallerSemanticPaths,
  resolveSemanticLocations,
} from './semantic/paths'
import {
  SEMANTIC_EMBEDDING_MODELS,
  resolveSemanticSearchConfig,
  type SemanticLocations,
  type SemanticChunk,
  type SemanticIndexStatus,
  type SemanticSearchConfig,
  type SemanticSearchRequest,
  type SemanticSearchResult,
  type SemanticSourceMessage,
} from './semantic/types'

/**
 * 语义索引调度（主进程）：
 * - 读取会话列表与消息（复用 chatService 的升序扫描游标）
 * - 按对话片段切块，交给 semanticIndexWorker 嵌入并写库
 * - 维护每个会话的索引游标，支持断点续建与增量更新
 *
 * 只处理 WeFlow 已能读出的明文消息，不涉及数据接入层。
 */

const STATUS_CHANNEL = 'semantic:status'
const DB_CHANGE_DEBOUNCE_MS = 30_000
const EXCLUDED_USERNAMES = new Set(['medianote', 'floatbottle', 'qmessage', 'qqmail', 'fmessage', 'newsapp', 'weixin', 'notifymessage'])

type WorkerReply = { id: number; ok: boolean; result?: unknown; error?: string }
type WorkerEvent = { event: string; data?: unknown }

class SemanticWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private closed = false

  constructor(
    /** 账号、模型与目录共同决定一个 worker；任一变化都需要重启 */
    readonly key: string,
    workerData: Record<string, unknown>,
    onEvent: (event: WorkerEvent) => void,
  ) {
    this.worker = new Worker(join(__dirname, 'semanticIndexWorker.js'), { workerData })
    this.worker.on('message', (message: WorkerReply | WorkerEvent) => {
      if ('event' in message) {
        onEvent(message)
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new Error(message.error || '语义索引 worker 出错'))
    })
    const failAll = (error: Error) => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    this.worker.on('error', (error) => failAll(error))
    this.worker.on('exit', (code) => failAll(new Error(`语义索引 worker 已退出 (${code})`)))
  }

  get alive(): boolean {
    return !this.closed
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('语义索引 worker 已关闭'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, method, params })
    })
  }

  async terminate(): Promise<void> {
    if (this.closed) return
    try { await this.call('close') } catch { /* ignore */ }
    this.closed = true
    await this.worker.terminate().catch(() => 0)
  }
}

class SemanticIndexService {
  private readonly configService = new ConfigService()
  private client: SemanticWorkerClient | null = null
  private syncPromise: Promise<void> | null = null
  private syncRequested = false
  private paused = false
  private abortController: AbortController | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private started = false
  private status: SemanticIndexStatus = {
    enabled: false,
    accountId: '',
    phase: 'idle',
    totalSessions: 0,
    doneSessions: 0,
    chunkCount: 0,
    modelReady: false,
  }

  getConfig(): SemanticSearchConfig {
    return resolveSemanticSearchConfig(this.configService.get('semanticSearch' as any))
  }

  setConfig(patch: Partial<SemanticSearchConfig>): SemanticSearchConfig {
    const next = resolveSemanticSearchConfig({ ...this.getConfig(), ...patch })
    this.configService.set('semanticSearch' as any, next as any)
    void this.applyConfig()
    return next
  }

  getStatus(): SemanticIndexStatus {
    return { ...this.status }
  }

  /** 当前生效的索引目录、模型目录与当前账号的索引文件 */
  getLocations(): SemanticLocations {
    const config = this.getConfig()
    const locations = resolveSemanticLocations(
      config,
      app.getPath('userData'),
      SEMANTIC_EMBEDDING_MODELS[config.embeddingMode].modelId,
    )
    const accountId = this.currentAccountId()
    return {
      ...locations,
      indexFile: accountId ? getSemanticIndexPath(locations.indexDir, accountId) : undefined,
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.importInstallerPaths()
    void this.applyConfig()
  }

  /**
   * 安装器的“语义检索存储位置”页面会写入 <安装目录>/semantic.ini。
   * 内容变化（首次安装或重新选择目录）时导入一次；之后以应用内设置为准，静默升级不会覆盖。
   */
  private importInstallerPaths(): void {
    if (!app.isPackaged) return
    const installer = readInstallerSemanticPaths()
    if (!installer) return
    const config = this.getConfig()
    if (config.installerPathsHash === installer.hash) return
    const next = resolveSemanticSearchConfig({
      ...config,
      indexDir: installer.indexDir,
      modelDir: installer.modelDir,
      installerPathsHash: installer.hash,
    })
    this.configService.set('semanticSearch' as any, next as any)
    console.info('[SemanticSearch] 已导入安装器设置的存储位置', { indexDir: next.indexDir, modelDir: next.modelDir })
  }

  async stop(): Promise<void> {
    this.started = false
    this.clearTimers()
    this.abortController?.abort()
    const client = this.client
    this.client = null
    await client?.terminate()
  }

  /** 配置或账号变化后调用：按需启停 worker 与定时增量 */
  async applyConfig(): Promise<void> {
    const config = this.getConfig()
    this.status.enabled = config.enabled
    this.clearTimers()
    if (!config.enabled || !this.started) {
      this.abortController?.abort()
      const client = this.client
      this.client = null
      await client?.terminate()
      this.updateStatus({ phase: 'idle' })
      return
    }
    // 账号、模型或目录可能已变化：先停下正在进行的索引，再按新设置继续
    this.abortController?.abort()
    await this.syncPromise?.catch(() => undefined)
    this.intervalTimer = setInterval(() => this.requestSync(), config.incrementalIntervalMinutes * 60_000)
    this.intervalTimer.unref?.()
    this.requestSync()
  }

  /** 数据库变化时由 main 调用，防抖后触发增量 */
  handleDbMonitorChange(): void {
    if (!this.getConfig().enabled) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.requestSync(), DB_CHANGE_DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  pause(): SemanticIndexStatus {
    this.paused = true
    this.abortController?.abort()
    this.updateStatus({ phase: 'paused' })
    return this.getStatus()
  }

  resume(): SemanticIndexStatus {
    this.paused = false
    this.updateStatus({ phase: 'idle' })
    this.requestSync()
    return this.getStatus()
  }

  /** 删除当前账号索引并从头重建 */
  async rebuild(): Promise<SemanticIndexStatus> {
    this.abortController?.abort()
    await this.syncPromise?.catch(() => undefined)
    const client = await this.ensureClient()
    await client.call('destroy')
    await client.terminate()
    this.client = null
    this.updateStatus({ chunkCount: 0, doneSessions: 0, totalSessions: 0 })
    this.paused = false
    this.requestSync()
    return this.getStatus()
  }

  async search(request: SemanticSearchRequest): Promise<SemanticSearchResult> {
    if (!this.getConfig().enabled) {
      return { success: false, error: '语义检索未开启，请先在设置中开启并完成索引' }
    }
    try {
      const client = await this.ensureClient()
      return await client.call<SemanticSearchResult>('search', request)
    } catch (error) {
      return { success: false, error: (error as Error)?.message || String(error) }
    }
  }

  requestSync(): void {
    if (!this.started || this.paused || !this.getConfig().enabled) return
    if (this.syncPromise) {
      this.syncRequested = true
      return
    }
    this.syncPromise = this.runSync()
      .catch((error) => {
        console.error('[SemanticSearch] 索引失败', error)
        this.updateStatus({ phase: 'error', error: (error as Error)?.message || String(error) })
      })
      .finally(() => {
        this.syncPromise = null
        if (this.syncRequested) {
          this.syncRequested = false
          this.requestSync()
        }
      })
  }

  private clearTimers(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.intervalTimer = null
    this.debounceTimer = null
  }

  private currentAccountId(): string {
    return this.configService.getMyAccountIdCleaned()
  }

  private async ensureClient(): Promise<SemanticWorkerClient> {
    const accountId = this.currentAccountId()
    if (!accountId) throw new Error('尚未选择微信账号')
    const config = this.getConfig()
    const locations = this.getLocations()
    const key = [accountId, config.embeddingMode, locations.indexDir, locations.modelDir, config.modelRemoteHost].join('|')
    if (this.client && this.client.alive && this.client.key === key) {
      return this.client
    }
    // 账号、模型或目录变化：关闭旧 worker，按新设置打开对应的独立索引
    const previous = this.client
    this.client = null
    await previous?.terminate()
    this.status.modelReady = false
    this.client = new SemanticWorkerClient(key, {
      indexDir: locations.indexDir,
      modelDir: locations.modelDir,
      bundledModelDir: locations.bundledModelDir,
      accountId,
      mode: config.embeddingMode,
      remoteHost: config.modelRemoteHost,
      threads: config.threads,
    }, (event) => this.handleWorkerEvent(event))
    this.status.accountId = accountId
    return this.client
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    if (event.event === 'modelProgress') {
      const info = (event.data || {}) as { status?: string; progress?: number }
      if (info.status === 'progress' && typeof info.progress === 'number') {
        this.updateStatus({ modelProgress: Math.round(info.progress) })
      }
    }
  }

  private updateStatus(patch: Partial<SemanticIndexStatus>): void {
    this.status = { ...this.status, ...patch, enabled: this.getConfig().enabled }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(STATUS_CHANNEL, this.status)
    }
  }

  private selectSessions(sessions: ChatSession[], includeGroups: boolean): ChatSession[] {
    return sessions
      .filter((session) => {
        const username = String(session.username || '').trim()
        if (!username || EXCLUDED_USERNAMES.has(username)) return false
        if (username.startsWith('gh_')) return false // 公众号
        if (username.includes('@placeholder') || username.startsWith('@')) return false
        if (username.endsWith('@chatroom')) return includeGroups
        return true
      })
      .sort((left, right) => (Number(right.lastTimestamp) || 0) - (Number(left.lastTimestamp) || 0))
  }

  private async loadNameMap(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    try {
      const contacts = await chatService.getContacts({ lite: true })
      for (const contact of contacts.contacts || []) {
        const name = String(contact.remark || contact.displayName || contact.nickname || '').trim()
        if (contact.username && name) names.set(contact.username, name)
      }
    } catch (error) {
      console.warn('[SemanticSearch] 读取联系人失败，发言人将显示为用户名', error)
    }
    return names
  }

  private async runSync(): Promise<void> {
    const config = this.getConfig()
    const accountId = this.currentAccountId()
    if (!accountId) return
    const client = await this.ensureClient()
    const controller = new AbortController()
    this.abortController = controller

    if (!this.status.modelReady) {
      this.updateStatus({ phase: 'preparing-model', error: undefined, modelProgress: 0 })
      await client.call('prepareModel')
      this.updateStatus({ modelReady: true, modelProgress: 100 })
    }

    const sessionsResult = await chatService.getSessions()
    if (!sessionsResult.success) throw new Error(sessionsResult.error || '读取会话列表失败')
    const sessions = this.selectSessions(sessionsResult.sessions || [], config.includeGroups)
    const stats = await client.call<{ chunkCount: number; cursors: Record<string, { lastMsgTs: number }> }>('stats')
    const pendingSessions = sessions.filter((session) => {
      const cursor = stats.cursors[session.username]
      return !cursor || cursor.lastMsgTs < (Number(session.lastTimestamp) || 0)
    })
    this.updateStatus({
      phase: pendingSessions.length > 0 ? 'indexing' : 'idle',
      totalSessions: sessions.length,
      doneSessions: sessions.length - pendingSessions.length,
      chunkCount: stats.chunkCount,
      error: undefined,
    })
    if (pendingSessions.length === 0) return

    const names = await this.loadNameMap()
    let done = sessions.length - pendingSessions.length
    for (const session of pendingSessions) {
      if (controller.signal.aborted || this.paused) break
      if (this.currentAccountId() !== accountId) break
      this.updateStatus({ currentSession: session.displayName || session.username })
      await this.indexSession(client, session, names, config, controller.signal)
      done += 1
      const latest = await client.call<{ chunkCount: number }>('stats')
      this.updateStatus({ doneSessions: done, chunkCount: latest.chunkCount })
    }
    this.updateStatus({
      phase: this.paused ? 'paused' : 'idle',
      currentSession: undefined,
      lastIndexedAt: Date.now(),
    })
  }

  private async indexSession(
    client: SemanticWorkerClient,
    session: ChatSession,
    names: Map<string, string>,
    config: SemanticSearchConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = session.username
    const isGroup = sessionId.endsWith('@chatroom')
    const stats = await client.call<{ cursors: Record<string, { lastMsgTs: number }> }>('stats')
    const hasCursor = Boolean(stats.cursors[sessionId])
    let fromTs = 0
    if (hasCursor) {
      // 会话的最后一段可能尚未结束：删除后从它的起点重新切块
      const lastStart = await client.call<number | null>('lastChunkStart', { sessionId })
      fromTs = lastStart || 0
      await client.call('deleteFrom', { sessionId, fromTs: fromTs || undefined })
    } else {
      // 没有游标说明从未完成过：清掉可能残留的半截数据
      await client.call('deleteFrom', { sessionId })
    }

    const chunker = new SemanticChunker({
      sessionId,
      sessionDisplayName: session.displayName || names.get(sessionId) || sessionId,
      isGroup,
      resolveSenderName: (username) => names.get(username) || username,
    }, config.chunking)

    let maxTs = fromTs
    let pendingInsert: Promise<unknown> = Promise.resolve()
    const flushChunks = (chunks: SemanticChunk[]) => {
      if (chunks.length === 0) return
      // 写入与下一批读取并行，但保持顺序
      pendingInsert = pendingInsert.then(() => client.call('insert', { chunks }))
    }

    const scan = await chatService.scanConversationMessagesForAnalysis(sessionId, {
      beginTimestamp: fromTs,
      batchSize: 2_000,
      maxMessages: 500_000,
      signal,
    }, async (batch) => {
      const messages: SemanticSourceMessage[] = batch.map((message) => ({
        localId: message.localId,
        localType: message.localType,
        createTime: message.createTime,
        sortSeq: message.sortSeq,
        isSend: message.isSend,
        senderUsername: message.senderUsername,
        parsedContent: message.parsedContent,
      }))
      for (const message of messages) maxTs = Math.max(maxTs, message.createTime)
      flushChunks(chunker.push(messages))
      // 背压：等待上一批写入完成，避免内存堆积
      await pendingInsert
    })
    if (signal.aborted) {
      await pendingInsert.catch(() => undefined)
      return
    }
    flushChunks(chunker.flush())
    await pendingInsert
    if (!scan.success) throw new Error(scan.error || `读取会话 ${sessionId} 失败`)
    await client.call('setCursor', {
      sessionId,
      lastMsgTs: Math.max(maxTs, scan.sourceExhausted ? Number(session.lastTimestamp) || 0 : 0),
    })
  }
}

export const semanticIndexService = new SemanticIndexService()
