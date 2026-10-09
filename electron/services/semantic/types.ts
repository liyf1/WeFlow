/**
 * 语义检索模块的共享类型。
 *
 * 本模块只消费 WeFlow 已读出的明文消息，不涉及任何数据接入、密钥或解密逻辑。
 */

/** 切块所需的最小消息结构（由 chatService 扫描结果映射而来） */
export interface SemanticSourceMessage {
  localId: number
  localType: number
  /** 秒级时间戳 */
  createTime: number
  sortSeq?: number
  isSend: number | null
  senderUsername?: string | null
  /** 已解析的可读文本 */
  parsedContent: string
}

export interface SemanticChunkingOptions {
  /** 相邻消息间隔超过该分钟数即切开新片段 */
  gapMinutes: number
  /** 单个片段的最大消息数 */
  maxMessages: number
  /** 单个片段的最大字符数（中文约等于 token 数） */
  maxChars: number
  /** 强制切开时与下一片段重叠的消息数 */
  overlapMessages: number
  /** 少于该条数的片段并入前一片段 */
  minMessages: number
}

export const DEFAULT_CHUNKING_OPTIONS: SemanticChunkingOptions = {
  gapMinutes: 30,
  maxMessages: 30,
  maxChars: 700,
  overlapMessages: 3,
  minMessages: 3,
}

/** 一个检索单元：同一会话中的一段连续对话 */
export interface SemanticChunk {
  sessionId: string
  isGroup: boolean
  startTs: number
  endTs: number
  firstLocalId: number
  lastLocalId: number
  /** 参与发言的用户名，"self" 表示本人 */
  speakers: string[]
  /** 拼接了元数据前缀、用于嵌入和展示的文本 */
  text: string
  messageCount: number
}

export interface StoredSemanticChunk extends SemanticChunk {
  id: number
}

export type SemanticEmbeddingMode = 'standard' | 'precise'

export interface SemanticEmbeddingModelSpec {
  mode: SemanticEmbeddingMode
  /** transformers.js 模型 ID */
  modelId: string
  dimensions: number
  /** 查询前缀（bge 系列推荐为查询加指令前缀） */
  queryPrefix: string
  dtype: 'q8' | 'fp32'
}

export const SEMANTIC_EMBEDDING_MODELS: Record<SemanticEmbeddingMode, SemanticEmbeddingModelSpec> = {
  standard: {
    mode: 'standard',
    modelId: 'Xenova/bge-small-zh-v1.5',
    dimensions: 512,
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    dtype: 'q8',
  },
  precise: {
    mode: 'precise',
    modelId: 'Xenova/bge-m3',
    dimensions: 1024,
    queryPrefix: '',
    dtype: 'q8',
  },
}

export interface SemanticSearchConfig {
  enabled: boolean
  embeddingMode: SemanticEmbeddingMode
  /** 模型下载源，默认使用 ModelScope 的 Hugging Face 镜像 */
  modelRemoteHost: string
  /** 首次全量索引时，嵌入线程使用的 CPU 线程数，0 表示自动取一半核心 */
  threads: number
  /** 是否索引群聊 */
  includeGroups: boolean
  /** 增量检查间隔（分钟） */
  incrementalIntervalMinutes: number
  chunking: SemanticChunkingOptions
}

export const DEFAULT_SEMANTIC_SEARCH_CONFIG: SemanticSearchConfig = {
  enabled: false,
  embeddingMode: 'standard',
  modelRemoteHost: 'https://hf-mirror.com/',
  threads: 0,
  includeGroups: true,
  incrementalIntervalMinutes: 5,
  chunking: DEFAULT_CHUNKING_OPTIONS,
}

export function resolveSemanticSearchConfig(raw: unknown): SemanticSearchConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<SemanticSearchConfig>
  const chunking = (value.chunking && typeof value.chunking === 'object' ? value.chunking : {}) as Partial<SemanticChunkingOptions>
  const mode: SemanticEmbeddingMode = value.embeddingMode === 'precise' ? 'precise' : 'standard'
  const num = (input: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(input)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(min, Math.min(max, Math.floor(parsed)))
  }
  return {
    enabled: value.enabled === true,
    embeddingMode: mode,
    modelRemoteHost: String(value.modelRemoteHost || DEFAULT_SEMANTIC_SEARCH_CONFIG.modelRemoteHost).trim()
      || DEFAULT_SEMANTIC_SEARCH_CONFIG.modelRemoteHost,
    threads: num(value.threads, 0, 0, 64),
    includeGroups: value.includeGroups !== false,
    incrementalIntervalMinutes: num(value.incrementalIntervalMinutes, 5, 1, 24 * 60),
    chunking: {
      gapMinutes: num(chunking.gapMinutes, DEFAULT_CHUNKING_OPTIONS.gapMinutes, 1, 24 * 60),
      maxMessages: num(chunking.maxMessages, DEFAULT_CHUNKING_OPTIONS.maxMessages, 5, 200),
      maxChars: num(chunking.maxChars, DEFAULT_CHUNKING_OPTIONS.maxChars, 200, 4000),
      overlapMessages: num(chunking.overlapMessages, DEFAULT_CHUNKING_OPTIONS.overlapMessages, 0, 10),
      minMessages: num(chunking.minMessages, DEFAULT_CHUNKING_OPTIONS.minMessages, 1, 20),
    },
  }
}

export interface SemanticSearchRequest {
  query: string
  sessionIds?: string[]
  /** 发言人用户名；"self" 表示本人 */
  speakers?: string[]
  beginTs?: number
  endTs?: number
  includeGroups?: boolean
  topK?: number
}

export interface SemanticSearchHit {
  chunkId: number
  sessionId: string
  isGroup: boolean
  startTs: number
  endTs: number
  firstLocalId: number
  lastLocalId: number
  text: string
  score: number
  matchedBy: Array<'vector' | 'keyword'>
}

export interface SemanticSearchResult {
  success: boolean
  hits?: SemanticSearchHit[]
  /** 索引未就绪、模型未下载等情况下的提示 */
  notice?: string
  error?: string
}

export type SemanticIndexPhase = 'idle' | 'preparing-model' | 'indexing' | 'paused' | 'error'

export interface SemanticIndexStatus {
  enabled: boolean
  accountId: string
  phase: SemanticIndexPhase
  totalSessions: number
  doneSessions: number
  chunkCount: number
  currentSession?: string
  modelReady: boolean
  modelProgress?: number
  lastIndexedAt?: number
  error?: string
}
