import type { RankedId, SemanticIndexFilter, SemanticIndexStore } from './indexStore'
import { buildFtsQuery } from './tokenize'
import type { SemanticSearchHit, SemanticSearchRequest, SemanticSearchResult } from './types'

const RRF_K = 60
const RECALL_PER_ROUTE = 50

/** Reciprocal Rank Fusion：score = Σ 1 / (60 + rank) */
export function fuseRankings(routes: Array<{ name: 'vector' | 'keyword'; ranked: RankedId[] }>): Array<{
  id: number
  score: number
  matchedBy: Array<'vector' | 'keyword'>
}> {
  const fused = new Map<number, { score: number; matchedBy: Set<'vector' | 'keyword'> }>()
  for (const route of routes) {
    route.ranked.forEach((item, index) => {
      const entry = fused.get(item.id) || { score: 0, matchedBy: new Set() }
      entry.score += 1 / (RRF_K + index + 1)
      entry.matchedBy.add(route.name)
      fused.set(item.id, entry)
    })
  }
  return Array.from(fused.entries())
    .map(([id, entry]) => ({ id, score: entry.score, matchedBy: Array.from(entry.matchedBy) }))
    .sort((left, right) => right.score - left.score)
}

export interface SearchDependencies {
  store: SemanticIndexStore
  /** 生成查询向量；返回 null 表示嵌入不可用，只走关键词召回 */
  embedQuery: (query: string) => Promise<Float32Array | null>
}

export async function searchSemanticIndex(
  deps: SearchDependencies,
  request: SemanticSearchRequest,
): Promise<SemanticSearchResult> {
  const query = String(request.query || '').trim().slice(0, 500)
  if (!query) return { success: false, error: '查询不能为空' }
  const topK = Math.max(1, Math.min(30, Math.floor(Number(request.topK) || 10)))
  const filter: SemanticIndexFilter = {
    sessionIds: request.sessionIds,
    speakers: request.speakers,
    beginTs: request.beginTs,
    endTs: request.endTs,
    includeGroups: request.includeGroups,
  }

  let notice: string | undefined
  let vectorRanked: RankedId[] = []
  try {
    const vector = await deps.embedQuery(query)
    if (vector) {
      vectorRanked = deps.store.vectorSearch(vector, filter, RECALL_PER_ROUTE)
    } else {
      notice = '嵌入模型尚未就绪，本次只使用关键词召回'
    }
  } catch (error) {
    notice = `向量检索失败，本次只使用关键词召回：${(error as Error)?.message || error}`
  }
  const keywordRanked = deps.store.keywordSearch(buildFtsQuery(query), filter, RECALL_PER_ROUTE)

  const fused = fuseRankings([
    { name: 'vector', ranked: vectorRanked },
    { name: 'keyword', ranked: keywordRanked },
  ]).slice(0, topK)
  const chunks = deps.store.getChunks(fused.map((item) => item.id))
  const hits: SemanticSearchHit[] = []
  for (const item of fused) {
    const chunk = chunks.get(item.id)
    if (!chunk) continue
    hits.push({
      chunkId: chunk.id,
      sessionId: chunk.sessionId,
      isGroup: chunk.isGroup,
      startTs: chunk.startTs,
      endTs: chunk.endTs,
      firstLocalId: chunk.firstLocalId,
      lastLocalId: chunk.lastLocalId,
      text: chunk.text,
      score: Number(item.score.toFixed(6)),
      matchedBy: item.matchedBy,
    })
  }
  return { success: true, hits, notice }
}
