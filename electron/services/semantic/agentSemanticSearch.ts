import { existsSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from '../config'
import { LocalEmbedder } from './embedder'
import { SemanticIndexStore } from './indexStore'
import { getSemanticIndexPath } from './paths'
import { searchSemanticIndex } from './searchCore'
import { resolveSemanticSearchConfig, type SemanticSearchRequest, type SemanticSearchResult } from './types'

/**
 * 供 AI agent（运行在 agentRunWorker 中）直接查询语义索引：
 * 以只读方式打开当前账号的索引库，并在本线程懒加载同一个嵌入模型来编码查询。
 * 索引写入始终由主进程的 semanticIndexWorker 负责。
 */

let cached: {
  key: string
  store: SemanticIndexStore
  embedder: LocalEmbedder
} | null = null

function userDataPath(): string {
  return String(process.env.WEFLOW_USER_DATA_PATH || '').trim() || app.getPath('userData')
}

export function isSemanticSearchEnabled(): boolean {
  try {
    return resolveSemanticSearchConfig(new ConfigService().get('semanticSearch' as any)).enabled
  } catch {
    return false
  }
}

export async function runAgentSemanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult> {
  const configService = new ConfigService()
  const config = resolveSemanticSearchConfig(configService.get('semanticSearch' as any))
  if (!config.enabled) {
    return { success: false, error: '语义检索未开启。请改用 search_raw_messages 做字面搜索。' }
  }
  const accountId = configService.getMyAccountIdCleaned()
  if (!accountId) return { success: false, error: '尚未选择微信账号' }
  const root = userDataPath()
  const path = getSemanticIndexPath(root, accountId)
  if (!existsSync(path)) {
    return { success: false, error: '当前账号的语义索引尚未建立。请改用 search_raw_messages 做字面搜索。' }
  }
  const key = `${path}|${config.embeddingMode}`
  if (!cached || cached.key !== key) {
    cached?.store.close()
    const embedder = new LocalEmbedder({
      mode: config.embeddingMode,
      userDataPath: root,
      remoteHost: config.modelRemoteHost,
      threads: 2,
    })
    const opened = SemanticIndexStore.open(path, {
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
      readonly: true,
    })
    if (opened.needsRebuild) {
      opened.store.close()
      return { success: false, error: '语义索引与当前嵌入模型不一致，正在等待重建。请改用 search_raw_messages。' }
    }
    cached = { key, store: opened.store, embedder }
  }
  const { store, embedder } = cached
  return searchSemanticIndex({
    store,
    embedQuery: async (query) => embedder.embedQuery(query),
  }, request)
}
