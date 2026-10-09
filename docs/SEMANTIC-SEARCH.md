# 语义检索

在本机为聊天记录建立语义索引，可以用自然语言描述找到对话（不必记得原话），AI agent 也能调用。
大模型仍使用设置里配置的云端服务；嵌入模型和索引都在本机运行，无需 Docker 或其他中间件。

## 使用

1. 侧边栏打开「语义检索」，勾选「开启语义检索」。
2. 首次开启会下载嵌入模型（默认 bge-small-zh，约百 MB），然后在后台按最近会话优先建立索引，可随时暂停。
3. 索引完成后，在页面搜索框输入描述即可；点击结果跳回原对话。
4. AI 页面中，agent 会在需要时调用 `semantic_search_messages` 工具。

每个微信账号一个独立索引文件：`<userData>/semantic-index/<accountId>.db`，切换账号会自动切换。
新消息会在数据库变化后约 30 秒，或每 5 分钟自动增量索引。

## 设置项（config 键 `semanticSearch`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `embeddingMode` | `standard` | `standard` = bge-small-zh（快）；`precise` = bge-m3（准，慢）。切换后会自动重建索引 |
| `modelRemoteHost` | `https://hf-mirror.com/` | 模型下载源，无法联网时可把模型放到 `<userData>/semantic-models/` |
| `includeGroups` | `true` | 是否索引群聊 |
| `threads` | `0` | 嵌入线程数，0 = CPU 核心数的一半 |
| `incrementalIntervalMinutes` | `5` | 定时增量检查间隔 |
| `chunking` | 见代码 | 切块参数：间隔 30 分钟切开、每块最多 30 条 / 700 字、重叠 3 条 |

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `electron/services/semanticIndexService.ts` | 主进程调度：读消息、切块、增量游标、IPC |
| `electron/semanticIndexWorker.ts` | worker 线程：嵌入计算与写库 |
| `electron/services/semantic/chunker.ts` | 对话片段切块 |
| `electron/services/semantic/indexStore.ts` | SQLite 索引：FTS5 + sqlite-vec（加载失败时退化为 JS 计算） |
| `electron/services/semantic/searchCore.ts` | 向量 + 关键词双路召回，RRF 融合 |
| `electron/services/semantic/embedder.ts` | transformers.js 本地嵌入 |
| `electron/services/semantic/agentSemanticSearch.ts` | agent 线程只读查询 |
| `src/pages/SemanticSearchPage.tsx` | 设置、进度与检索界面 |

## 测试

```bash
npm run test:semantic
```

测试覆盖切块规则、分词、RRF 融合、索引读写、增量删除、只读打开、模型变更重建，以及 sqlite-vec 与 JS 检索结果一致性。
