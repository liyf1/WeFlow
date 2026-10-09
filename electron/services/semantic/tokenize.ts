/**
 * 中文分词：复用项目已依赖的 jieba-wasm，为 FTS5 关键词检索准备分好词的文本。
 * 采用 cut_for_search 模式，长词会再切出子词，提高召回。
 */

type JiebaModule = {
  cut_for_search?: (text: string, hmm?: boolean) => string[]
  cut?: (text: string, hmm?: boolean) => string[]
}

let jieba: JiebaModule | null | undefined

function loadJieba(): JiebaModule | null {
  if (jieba !== undefined) return jieba
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    jieba = require('jieba-wasm/node') as JiebaModule
  } catch (error) {
    console.warn('[SemanticSearch] jieba-wasm 加载失败，退化为按字切分', error)
    jieba = null
  }
  return jieba
}

const PUNCTUATION = /^[\s\p{P}\p{S}]+$/u

function fallbackSplit(text: string): string[] {
  const tokens: string[] = []
  const pattern = /[\p{Script=Han}]|[\p{L}\p{N}_]+/gu
  for (const match of text.matchAll(pattern)) tokens.push(match[0])
  return tokens
}

export function tokenizeForIndex(text: string): string[] {
  const source = String(text || '').toLowerCase()
  if (!source.trim()) return []
  const module = loadJieba()
  const raw = module?.cut_for_search
    ? module.cut_for_search(source, true)
    : module?.cut
      ? module.cut(source, true)
      : fallbackSplit(source)
  const tokens: string[] = []
  for (const token of raw) {
    const value = String(token || '').trim()
    if (!value || PUNCTUATION.test(value)) continue
    // FTS5 的双引号需要转义，这里直接去掉
    tokens.push(value.replace(/"/g, ''))
  }
  return tokens
}

/** 生成 FTS5 MATCH 查询：各词以 OR 连接；有多字词时丢弃单字词以减少噪声 */
export function buildFtsQuery(text: string): string {
  const tokens = Array.from(new Set(tokenizeForIndex(text))).filter(Boolean)
  if (tokens.length === 0) return ''
  const multi = tokens.filter((token) => [...token].length > 1)
  const selected = (multi.length > 0 ? multi : tokens).slice(0, 32)
  return selected.map((token) => `"${token}"`).join(' OR ')
}
