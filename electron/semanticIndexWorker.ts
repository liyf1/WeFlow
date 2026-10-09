import { parentPort, workerData, type MessagePort } from 'worker_threads'
import { existsSync, rmSync } from 'fs'
import { LocalEmbedder } from './services/semantic/embedder'
import { SemanticIndexStore } from './services/semantic/indexStore'
import { getSemanticIndexPath } from './services/semantic/paths'
import { searchSemanticIndex } from './services/semantic/searchCore'
import { tokenizeForIndex } from './services/semantic/tokenize'
import type { SemanticChunk, SemanticEmbeddingMode, SemanticSearchRequest } from './services/semantic/types'

/**
 * 语义索引 worker：持有索引库写连接和嵌入模型，所有耗 CPU 的工作都在这里完成，
 * 主进程只负责读取消息、切块和调度。
 *
 * 协议：主进程发送 { id, method, params }，worker 回复 { id, ok, result | error }；
 * 进度类事件以 { event, data } 推送。
 */

interface WorkerInit {
  userDataPath: string
  accountId: string
  mode: SemanticEmbeddingMode
  remoteHost?: string
  threads?: number
}

const init = workerData as WorkerInit
if (!parentPort) throw new Error('semanticIndexWorker 必须在 worker 线程中运行')
const port: MessagePort = parentPort

const embedder = new LocalEmbedder({
  mode: init.mode,
  userDataPath: init.userDataPath,
  remoteHost: init.remoteHost,
  threads: init.threads,
  onProgress: (info) => port.postMessage({ event: 'modelProgress', data: info }),
})

let modelReady = false
let store: SemanticIndexStore | null = null

function openStore(): SemanticIndexStore {
  if (store) return store
  const path = getSemanticIndexPath(init.userDataPath, init.accountId)
  const opened = SemanticIndexStore.open(path, { modelId: embedder.modelId, dimensions: embedder.dimensions })
  if (opened.needsRebuild) {
    // 嵌入模型或维度变化：旧向量不可复用，整库重建
    opened.store.reset(embedder.modelId)
    port.postMessage({ event: 'rebuildRequired', data: { path } })
  }
  store = opened.store
  return store
}

const handlers: Record<string, (params: any) => Promise<unknown> | unknown> = {
  async prepareModel() {
    await embedder.ready()
    modelReady = true
    return { modelId: embedder.modelId, dimensions: embedder.dimensions }
  },

  stats() {
    const current = openStore()
    return {
      chunkCount: current.countChunks(),
      cursors: Object.fromEntries(current.listCursors()),
      vectorExtension: current.hasVectorExtension,
      modelReady,
    }
  },

  /** 删除会话中 start_ts >= fromTs 的片段，返回删除数量 */
  deleteFrom(params: { sessionId: string; fromTs?: number }) {
    return openStore().deleteSessionChunks(params.sessionId, params.fromTs)
  },

  lastChunkStart(params: { sessionId: string }) {
    return openStore().getLastChunkStart(params.sessionId) ?? null
  },

  async insert(params: { chunks: SemanticChunk[] }) {
    const chunks = params.chunks || []
    if (chunks.length === 0) return 0
    const vectors = await embedder.embedDocuments(chunks.map((chunk) => chunk.text))
    modelReady = true
    const tokens = chunks.map((chunk) => tokenizeForIndex(chunk.text))
    openStore().insertChunks(chunks, vectors, tokens)
    return chunks.length
  },

  setCursor(params: { sessionId: string; lastMsgTs: number }) {
    openStore().setCursor(params.sessionId, params.lastMsgTs)
    return true
  },

  async search(params: SemanticSearchRequest) {
    return searchSemanticIndex({
      store: openStore(),
      embedQuery: async (query) => embedder.embedQuery(query),
    }, params)
  },

  /** 删除整个索引文件（用户手动重建或删除账号时） */
  destroy() {
    const path = getSemanticIndexPath(init.userDataPath, init.accountId)
    store?.close()
    store = null
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${path}${suffix}`
      if (existsSync(target)) rmSync(target, { force: true })
    }
    return true
  },

  close() {
    store?.close()
    store = null
    return true
  },
}

// 串行执行请求：better-sqlite3 是同步的，嵌入也是 CPU 密集型，排队可避免互相抢占
let queue: Promise<void> = Promise.resolve()

port.on('message', (message: { id: number; method: string; params?: unknown }) => {
  const handler = handlers[message?.method]
  if (!handler) {
    port.postMessage({ id: message?.id, ok: false, error: `未知方法: ${message?.method}` })
    return
  }
  // 搜索请求插队执行，避免被长时间的索引任务阻塞
  const run = async () => {
    try {
      const result = await handler(message.params)
      port.postMessage({ id: message.id, ok: true, result })
    } catch (error) {
      port.postMessage({ id: message.id, ok: false, error: (error as Error)?.message || String(error) })
    }
  }
  if (message.method === 'search' || message.method === 'stats') {
    void run()
    return
  }
  queue = queue.then(run)
})
