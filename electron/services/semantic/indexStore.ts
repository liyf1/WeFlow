import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type BetterSqlite3 from 'better-sqlite3'
import type { SemanticChunk, StoredSemanticChunk } from './types'

/**
 * 每个微信账号一个 SQLite 文件，保存检索所需的派生数据：
 * - chunks：对话片段及其元数据
 * - chunk_vectors：片段向量（float32 BLOB），作为向量的唯一真源
 * - chunks_fts：FTS5 关键词索引（存 jieba 分好词的文本）
 * - chunks_vec：sqlite-vec 加速索引（扩展加载失败时自动退化为 JS 暴力检索）
 * - session_cursor：每个会话的索引进度
 */

export const INDEX_SCHEMA_VERSION = 1

export interface SemanticIndexFilter {
  sessionIds?: string[]
  speakers?: string[]
  beginTs?: number
  endTs?: number
  includeGroups?: boolean
}

export interface SessionCursor {
  sessionId: string
  lastMsgTs: number
  updatedAt: number
}

export interface RankedId {
  id: number
  score: number
}

type DatabaseConstructor = typeof BetterSqlite3

function loadDatabaseConstructor(): DatabaseConstructor {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('better-sqlite3') as DatabaseConstructor
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function fromBlob(blob: Buffer): Float32Array {
  // 拷贝一次以保证 4 字节对齐
  const copy = new Float32Array(blob.byteLength / 4)
  new Uint8Array(copy.buffer).set(blob)
  return copy
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index]
  return sum
}

/** 维护前 k 个最高分（k 很小，线性插入即可） */
class TopK {
  private readonly items: RankedId[] = []
  constructor(private readonly k: number) {}
  offer(id: number, score: number): void {
    if (this.items.length >= this.k && score <= this.items[this.items.length - 1].score) return
    let index = this.items.length
    while (index > 0 && this.items[index - 1].score < score) index -= 1
    this.items.splice(index, 0, { id, score })
    if (this.items.length > this.k) this.items.pop()
  }
  values(): RankedId[] {
    return this.items
  }
}

export class SemanticIndexStore {
  readonly path: string
  readonly dimensions: number
  private readonly db: BetterSqlite3.Database
  private vecAvailable = false

  private constructor(path: string, db: BetterSqlite3.Database, dimensions: number) {
    this.path = path
    this.db = db
    this.dimensions = dimensions
  }

  /**
   * 打开（必要时创建）索引库。
   * modelId / dimensions 与库中记录不一致时，返回 needsRebuild=true，由调用方决定是否清空重建。
   */
  static open(path: string, options: { modelId: string; dimensions: number; readonly?: boolean }): {
    store: SemanticIndexStore
    needsRebuild: boolean
  } {
    const Database = loadDatabaseConstructor()
    if (!options.readonly) mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path, { readonly: options.readonly === true, fileMustExist: options.readonly === true })
    if (!options.readonly) {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
    }
    db.pragma('busy_timeout = 5000')
    const store = new SemanticIndexStore(path, db, options.dimensions)
    store.tryLoadVec()
    let needsRebuild = false
    if (!options.readonly) {
      store.ensureSchema()
      const storedModel = store.getMeta('model_id')
      const storedDims = Number(store.getMeta('dimensions') || 0)
      const storedSchema = Number(store.getMeta('schema_version') || 0)
      if (storedModel && (storedModel !== options.modelId || storedDims !== options.dimensions || storedSchema !== INDEX_SCHEMA_VERSION)) {
        needsRebuild = true
      } else if (!storedModel) {
        store.setMeta('model_id', options.modelId)
        store.setMeta('dimensions', String(options.dimensions))
        store.setMeta('schema_version', String(INDEX_SCHEMA_VERSION))
      }
      store.ensureVecTable()
    } else {
      const storedModel = store.getMeta('model_id')
      const storedDims = Number(store.getMeta('dimensions') || 0)
      needsRebuild = !storedModel || storedModel !== options.modelId || storedDims !== options.dimensions
    }
    return { store, needsRebuild }
  }

  get hasVectorExtension(): boolean {
    return this.vecAvailable
  }

  close(): void {
    try { this.db.close() } catch { /* ignore */ }
  }

  private tryLoadVec(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string }
      // 打包后扩展位于 app.asar.unpacked
      const loadable = sqliteVec.getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
      this.db.loadExtension(loadable)
      this.vecAvailable = true
    } catch (error) {
      this.vecAvailable = false
      console.warn('[SemanticSearch] sqlite-vec 加载失败，向量检索将使用 JS 实现', (error as Error)?.message || error)
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS session_cursor (
        session_id TEXT PRIMARY KEY,
        last_msg_ts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        first_local_id INTEGER NOT NULL,
        last_local_id INTEGER NOT NULL,
        speakers TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session_ts ON chunks(session_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(start_ts);
      CREATE TABLE IF NOT EXISTS chunk_vectors (id INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(tokens);
    `)
  }

  private ensureVecTable(): void {
    if (!this.vecAvailable) return
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.dimensions}])`)
    } catch (error) {
      console.warn('[SemanticSearch] 创建 vec0 表失败，退化为 JS 检索', error)
      this.vecAvailable = false
    }
  }

  private hasVecTable(): boolean {
    if (!this.vecAvailable) return false
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_vec'").get()
    return Boolean(row)
  }

  getMeta(key: string): string | undefined {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
      return row?.value
    } catch {
      return undefined
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** 清空所有数据并按当前模型重新写入元信息 */
  reset(modelId: string): void {
    this.db.exec(`
      DELETE FROM chunks;
      DELETE FROM chunk_vectors;
      DELETE FROM chunks_fts;
      DELETE FROM session_cursor;
      DELETE FROM meta;
    `)
    this.db.exec('DROP TABLE IF EXISTS chunks_vec')
    this.setMeta('model_id', modelId)
    this.setMeta('dimensions', String(this.dimensions))
    this.setMeta('schema_version', String(INDEX_SCHEMA_VERSION))
    this.ensureVecTable()
  }

  getCursor(sessionId: string): SessionCursor | undefined {
    const row = this.db.prepare('SELECT session_id, last_msg_ts, updated_at FROM session_cursor WHERE session_id = ?').get(sessionId) as
      | { session_id: string; last_msg_ts: number; updated_at: number }
      | undefined
    if (!row) return undefined
    return { sessionId: row.session_id, lastMsgTs: Number(row.last_msg_ts) || 0, updatedAt: Number(row.updated_at) || 0 }
  }

  listCursors(): Map<string, SessionCursor> {
    const rows = this.db.prepare('SELECT session_id, last_msg_ts, updated_at FROM session_cursor').all() as Array<{ session_id: string; last_msg_ts: number; updated_at: number }>
    return new Map(rows.map((row) => [row.session_id, {
      sessionId: row.session_id,
      lastMsgTs: Number(row.last_msg_ts) || 0,
      updatedAt: Number(row.updated_at) || 0,
    }]))
  }

  setCursor(sessionId: string, lastMsgTs: number): void {
    this.db.prepare(`
      INSERT INTO session_cursor(session_id, last_msg_ts, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_msg_ts = excluded.last_msg_ts, updated_at = excluded.updated_at
    `).run(sessionId, Math.floor(lastMsgTs), Date.now())
  }

  /** 会话最后一个片段的起始时间；增量更新时从这里重建（最后一段可能还没结束） */
  getLastChunkStart(sessionId: string): number | undefined {
    const row = this.db.prepare('SELECT MAX(start_ts) AS ts FROM chunks WHERE session_id = ?').get(sessionId) as { ts?: number | null } | undefined
    return row?.ts ? Number(row.ts) : undefined
  }

  /** 删除某会话 start_ts >= fromTs 的片段（fromTs 省略时删除整个会话） */
  deleteSessionChunks(sessionId: string, fromTs?: number): number {
    const ids = (fromTs === undefined
      ? this.db.prepare('SELECT id FROM chunks WHERE session_id = ?').all(sessionId)
      : this.db.prepare('SELECT id FROM chunks WHERE session_id = ? AND start_ts >= ?').all(sessionId, Math.floor(fromTs))
    ) as Array<{ id: number }>
    if (ids.length === 0) return 0
    const hasVec = this.hasVecTable()
    const removeChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
    const removeVector = this.db.prepare('DELETE FROM chunk_vectors WHERE id = ?')
    const removeFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?')
    const removeVec = hasVec ? this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?') : null
    const tx = this.db.transaction((rows: Array<{ id: number }>) => {
      for (const { id } of rows) {
        removeChunk.run(id)
        removeVector.run(id)
        removeFts.run(id)
        removeVec?.run(BigInt(id))
      }
    })
    tx(ids)
    return ids.length
  }

  insertChunks(chunks: SemanticChunk[], embeddings: Float32Array[], tokenized: string[][]): number[] {
    if (chunks.length !== embeddings.length || chunks.length !== tokenized.length) {
      throw new Error('片段、向量与分词数量不一致')
    }
    const hasVec = this.hasVecTable()
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks(session_id, is_group, start_ts, end_ts, first_local_id, last_local_id, speakers, message_count, text)
      VALUES(@sessionId, @isGroup, @startTs, @endTs, @firstLocalId, @lastLocalId, @speakers, @messageCount, @text)
    `)
    const insertVector = this.db.prepare('INSERT INTO chunk_vectors(id, embedding) VALUES(?, ?)')
    const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, tokens) VALUES(?, ?)')
    const insertVec = hasVec ? this.db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES(?, ?)') : null
    const ids: number[] = []
    const tx = this.db.transaction(() => {
      chunks.forEach((chunk, index) => {
        const result = insertChunk.run({
          sessionId: chunk.sessionId,
          isGroup: chunk.isGroup ? 1 : 0,
          startTs: Math.floor(chunk.startTs),
          endTs: Math.floor(chunk.endTs),
          firstLocalId: Math.floor(chunk.firstLocalId),
          lastLocalId: Math.floor(chunk.lastLocalId),
          speakers: `,${chunk.speakers.join(',')},`,
          messageCount: chunk.messageCount,
          text: chunk.text,
        })
        const id = Number(result.lastInsertRowid)
        const blob = toBlob(embeddings[index])
        insertVector.run(id, blob)
        insertFts.run(id, tokenized[index].join(' '))
        insertVec?.run(BigInt(id), blob)
        ids.push(id)
      })
    })
    tx()
    return ids
  }

  countChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    return Number(row?.n) || 0
  }

  getChunks(ids: number[]): Map<number, StoredSemanticChunk> {
    const result = new Map<number, StoredSemanticChunk>()
    if (ids.length === 0) return result
    const statement = this.db.prepare(`SELECT * FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
    const rows = statement.all(...ids) as Array<Record<string, any>>
    for (const row of rows) {
      result.set(Number(row.id), {
        id: Number(row.id),
        sessionId: String(row.session_id),
        isGroup: Number(row.is_group) === 1,
        startTs: Number(row.start_ts),
        endTs: Number(row.end_ts),
        firstLocalId: Number(row.first_local_id),
        lastLocalId: Number(row.last_local_id),
        speakers: String(row.speakers || '').split(',').filter(Boolean),
        messageCount: Number(row.message_count) || 0,
        text: String(row.text || ''),
      })
    }
    return result
  }

  private buildFilterSql(filter: SemanticIndexFilter, alias = 'c'): { where: string; params: unknown[]; active: boolean } {
    const clauses: string[] = []
    const params: unknown[] = []
    const sessionIds = (filter.sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)
    if (sessionIds.length > 0) {
      clauses.push(`${alias}.session_id IN (${sessionIds.map(() => '?').join(',')})`)
      params.push(...sessionIds)
    }
    const speakers = (filter.speakers || []).map((id) => String(id || '').trim()).filter(Boolean)
    if (speakers.length > 0) {
      // speakers 存为 ",a,b,"，用 instr 精确匹配（用户名常含下划线，不能用 LIKE）
      clauses.push(`(${speakers.map(() => `instr(${alias}.speakers, ?) > 0`).join(' OR ')})`)
      params.push(...speakers.map((speaker) => `,${speaker.replace(/,/g, '')},`))
    }
    if (filter.beginTs && filter.beginTs > 0) {
      clauses.push(`${alias}.end_ts >= ?`)
      params.push(Math.floor(filter.beginTs))
    }
    if (filter.endTs && filter.endTs > 0) {
      clauses.push(`${alias}.start_ts <= ?`)
      params.push(Math.floor(filter.endTs))
    }
    if (filter.includeGroups === false) clauses.push(`${alias}.is_group = 0`)
    return { where: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1', params, active: clauses.length > 0 }
  }

  /** 向量召回：无过滤条件且有 sqlite-vec 时走 KNN，否则在过滤后的候选集上暴力计算点积 */
  vectorSearch(query: Float32Array, filter: SemanticIndexFilter, k: number): RankedId[] {
    const limit = Math.max(1, Math.min(500, Math.floor(k)))
    const { where, params, active } = this.buildFilterSql(filter)
    if (!active && this.hasVecTable()) {
      try {
        const rows = this.db.prepare(
          'SELECT rowid AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
        ).all(toBlob(query), limit) as Array<{ id: number | bigint; distance: number }>
        // 向量已归一化：L2 距离 d 与余弦相似度满足 cos = 1 - d² / 2
        return rows.map((row) => ({ id: Number(row.id), score: 1 - (Number(row.distance) ** 2) / 2 }))
      } catch (error) {
        console.warn('[SemanticSearch] vec0 查询失败，改用 JS 检索', error)
      }
    }
    const top = new TopK(limit)
    const statement = this.db.prepare(
      `SELECT v.id AS id, v.embedding AS embedding FROM chunk_vectors v JOIN chunks c ON c.id = v.id WHERE ${where}`,
    )
    for (const row of statement.iterate(...params) as Iterable<{ id: number; embedding: Buffer }>) {
      top.offer(Number(row.id), dot(query, fromBlob(row.embedding)))
    }
    return top.values()
  }

  /** 关键词召回：FTS5 BM25（bm25 越小越相关，这里取负数作为分数） */
  keywordSearch(ftsQuery: string, filter: SemanticIndexFilter, k: number): RankedId[] {
    if (!ftsQuery) return []
    const limit = Math.max(1, Math.min(500, Math.floor(k)))
    const { where, params } = this.buildFilterSql(filter)
    try {
      const rows = this.db.prepare(`
        SELECT f.rowid AS id, bm25(chunks_fts) AS rank
        FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH ? AND ${where}
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, ...params, limit) as Array<{ id: number; rank: number }>
      return rows.map((row) => ({ id: Number(row.id), score: -Number(row.rank) }))
    } catch (error) {
      console.warn('[SemanticSearch] FTS 查询失败', error)
      return []
    }
  }
}
