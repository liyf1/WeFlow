import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkMessages, SemanticChunker } from '../electron/services/semantic/chunker'
import { SemanticIndexStore } from '../electron/services/semantic/indexStore'
import { searchSemanticIndex, fuseRankings } from '../electron/services/semantic/searchCore'
import { tokenizeForIndex, buildFtsQuery } from '../electron/services/semantic/tokenize'
import type { SemanticSourceMessage } from '../electron/services/semantic/types'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('ok -', name) }

// 假嵌入：按字符 bigram 哈希到 64 维再归一化，语义相近（共享字）的文本得分更高
const DIM = 64
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM)
  const chars = [...text.replace(/\s/g, '')]
  for (let i = 0; i < chars.length; i++) {
    const h = (chars[i].codePointAt(0)! * 31 + (chars[i + 1]?.codePointAt(0) || 7)) % DIM
    v[h] += 1
  }
  const n = Math.hypot(...v) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}

const base = 1_700_000_000
const msg = (id: number, t: number, text: string, isSend = 0, sender?: string): SemanticSourceMessage =>
  ({ localId: id, localType: 1, createTime: base + t, isSend, senderUsername: sender ?? null, parsedContent: text })

;(async () => {
  await test('按时间间隔切块，并给片段加元数据前缀', () => {
    const chunks = chunkMessages({ sessionId: 'wxid_a', sessionDisplayName: '张三', isGroup: false }, [
      msg(1, 0, '在吗'), msg(2, 10, '在的', 1), msg(3, 20, '下个月我去新公司报到了'),
      msg(4, 4000, '晚饭吃什么'), msg(5, 4010, '火锅', 1), msg(6, 4020, '好'),
    ])
    assert.equal(chunks.length, 2)
    assert.match(chunks[0].text, /^\[私聊·张三 · \d{4}-\d{2}-\d{2} .+\]\n张三：在吗\n我：在的/)
    assert.deepEqual(chunks[0].speakers.sort(), ['self', 'wxid_a'])
    assert.equal(chunks[1].firstLocalId, 4)
  })

  await test('超长片段强制切开并重叠 3 条', () => {
    const many = Array.from({ length: 70 }, (_, i) => msg(i + 1, i * 10, `消息${i}`))
    const chunks = chunkMessages({ sessionId: 's', sessionDisplayName: 'S', isGroup: false }, many, { maxMessages: 30 })
    assert.equal(chunks.length, 3)
    assert.equal(chunks[1].firstLocalId, chunks[0].lastLocalId - 2)
  })

  await test('少于 3 条的片段并入前一片段', () => {
    const chunks = chunkMessages({ sessionId: 's', sessionDisplayName: 'S', isGroup: false }, [
      msg(1, 0, 'a'), msg(2, 5, 'b'), msg(3, 10, 'c'), msg(4, 9000, '孤零零一条'),
    ])
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].lastLocalId, 4)
  })

  await test('流式分批推入与一次性切块结果一致', () => {
    const list = Array.from({ length: 50 }, (_, i) => msg(i + 1, i * (i % 7 === 0 ? 2000 : 30), `第${i}条`))
    const once = chunkMessages({ sessionId: 's', sessionDisplayName: 'S', isGroup: false }, list)
    const chunker = new SemanticChunker({ sessionId: 's', sessionDisplayName: 'S', isGroup: false })
    const streamed = [...chunker.push(list.slice(0, 17)), ...chunker.push(list.slice(17, 33)), ...chunker.push(list.slice(33)), ...chunker.flush()]
    assert.deepEqual(streamed.map((c) => c.text), once.map((c) => c.text))
  })

  await test('群聊用发言人显示名', () => {
    const [chunk] = chunkMessages({ sessionId: 'g@chatroom', sessionDisplayName: '家庭群', isGroup: true, resolveSenderName: (u) => (u === 'wxid_m' ? '妈妈' : u) }, [
      msg(1, 0, '周末回家吃饭', 0, 'wxid_m'), msg(2, 5, '好的', 1), msg(3, 9, '收到', 0, 'wxid_b'),
    ])
    assert.match(chunk.text, /妈妈：周末回家吃饭\n我：好的\nwxid_b：收到/)
    assert.deepEqual(chunk.speakers.sort(), ['self', 'wxid_b', 'wxid_m'])
  })

  await test('jieba 分词与 FTS 查询构造', () => {
    const tokens = tokenizeForIndex('我下个月去新公司报到')
    assert.ok(tokens.includes('公司'), tokens.join('|'))
    const q = buildFtsQuery('装修预算多少')
    assert.match(q, /"装修"/)
  })

  await test('RRF 融合：两路都命中的排在前面', () => {
    const fused = fuseRankings([
      { name: 'vector', ranked: [{ id: 1, score: 0.9 }, { id: 2, score: 0.8 }] },
      { name: 'keyword', ranked: [{ id: 2, score: 5 }, { id: 3, score: 4 }] },
    ])
    assert.equal(fused[0].id, 2)
    assert.deepEqual(fused[0].matchedBy.sort(), ['keyword', 'vector'])
  })

  const dir = mkdtempSync(join(tmpdir(), 'semantic-'))
  const path = join(dir, 'acc.db')
  const corpus = [
    { sid: 'wxid_a', name: '张三', group: false, msgs: [msg(1, 0, '我下个月要去新公司报到了'), msg(2, 30, '恭喜换工作！', 1), msg(3, 60, '薪资涨了不少')] },
    { sid: 'wxid_b', name: '李四', group: false, msgs: [msg(1, 100, '装修预算大概二十万'), msg(2, 130, '厨房要重新做', 1), msg(3, 160, '瓷砖还没选')] },
    { sid: 'g@chatroom', name: '家庭群', group: true, msgs: [msg(1, 200, '周末回家吃饭', 0, 'wxid_m'), msg(2, 230, '好的', 1), msg(3, 260, '做红烧肉', 0, 'wxid_m')] },
  ]

  for (const useVec of [true, false]) {
    await test(`索引写入与混合检索（sqlite-vec=${useVec}）`, async () => {
      const file = path.replace('.db', `-${useVec}.db`)
      const { store, needsRebuild } = SemanticIndexStore.open(file, { modelId: 'fake', dimensions: DIM })
      assert.equal(needsRebuild, false)
      if (!useVec) (store as any).vecAvailable = false
      else assert.equal(store.hasVectorExtension, true)
      for (const c of corpus) {
        const chunks = chunkMessages({ sessionId: c.sid, sessionDisplayName: c.name, isGroup: c.group }, c.msgs)
        store.insertChunks(chunks, chunks.map((x) => fakeEmbed(x.text)), chunks.map((x) => tokenizeForIndex(x.text)))
        store.setCursor(c.sid, base + 999)
      }
      assert.equal(store.countChunks(), 3)
      const deps = { store, embedQuery: async (q: string) => fakeEmbed(q) }

      const r1 = await searchSemanticIndex(deps, { query: '装修预算' })
      assert.equal(r1.success, true)
      assert.equal(r1.hits![0].sessionId, 'wxid_b')
      assert.ok(r1.hits![0].matchedBy.includes('keyword'))

      const r2 = await searchSemanticIndex(deps, { query: '新公司', includeGroups: false, sessionIds: ['wxid_a'] })
      assert.deepEqual(r2.hits!.map((h) => h.sessionId), ['wxid_a'])

      const r3 = await searchSemanticIndex(deps, { query: '吃饭', includeGroups: false })
      assert.ok(r3.hits!.every((h) => !h.isGroup))

      const r4 = await searchSemanticIndex(deps, { query: '红烧肉', speakers: ['wxid_m'] })
      assert.deepEqual(r4.hits!.map((h) => h.sessionId), ['g@chatroom'])

      const r5 = await searchSemanticIndex(deps, { query: '红烧肉', endTs: base + 150 })
      assert.ok(r5.hits!.every((h) => h.startTs <= base + 150))

      // 嵌入不可用时退化为关键词
      const r6 = await searchSemanticIndex({ store, embedQuery: async () => null }, { query: '瓷砖' })
      assert.equal(r6.hits![0].sessionId, 'wxid_b')
      assert.ok(r6.notice)

      // 增量：删除并重建某会话的末段
      assert.equal(store.getLastChunkStart('wxid_b'), base + 100)
      assert.equal(store.deleteSessionChunks('wxid_b', base + 100), 1)
      assert.equal(store.countChunks(), 2)
      const after = await searchSemanticIndex(deps, { query: '装修预算' })
      assert.ok(after.hits!.every((h) => h.sessionId !== 'wxid_b'))
      assert.equal(store.getCursor('wxid_a')?.lastMsgTs, base + 999)
      store.close()

      // 只读打开（agent 线程）
      const ro = SemanticIndexStore.open(file, { modelId: 'fake', dimensions: DIM, readonly: true })
      assert.equal(ro.needsRebuild, false)
      const r7 = await searchSemanticIndex({ store: ro.store, embedQuery: async (q) => fakeEmbed(q) }, { query: '换工作' })
      assert.equal(r7.hits![0].sessionId, 'wxid_a')
      ro.store.close()

      // 模型变化 → 需要重建；reset 后清空
      const changed = SemanticIndexStore.open(file, { modelId: 'other-model', dimensions: DIM })
      assert.equal(changed.needsRebuild, true)
      changed.store.reset('other-model')
      assert.equal(changed.store.countChunks(), 0)
      assert.equal(changed.store.getMeta('model_id'), 'other-model')
      changed.store.close()
    })
  }

  await test('vec0 KNN 与 JS 暴力检索排序一致', () => {
    const file = path.replace('.db', '-knn.db')
    const { store } = SemanticIndexStore.open(file, { modelId: 'fake', dimensions: DIM })
    const texts = Array.from({ length: 200 }, (_, i) => `片段${i} ${'天气工作装修旅行吃饭'.slice(i % 8, (i % 8) + 3)} ${i * 7}`)
    const chunks = texts.map((text, i) => ({ sessionId: `s${i % 5}`, isGroup: false, startTs: base + i, endTs: base + i, firstLocalId: i, lastLocalId: i, speakers: ['self'], text, messageCount: 1 }))
    store.insertChunks(chunks, texts.map(fakeEmbed), texts.map(tokenizeForIndex))
    const q = fakeEmbed('装修旅行')
    const knn = store.vectorSearch(q, {}, 10)
    ;(store as any).vecAvailable = false
    const brute = store.vectorSearch(q, {}, 10)
    assert.deepEqual(knn.map((x) => x.score.toFixed(4)), brute.map((x) => x.score.toFixed(4)))
    for (let i = 0; i < 10; i++) assert.ok(Math.abs(knn[i].score - brute[i].score) < 1e-4)
    store.close()
  })

  console.log(`\n${passed} passed`)
})().catch((e) => { console.error(e); process.exit(1) })
