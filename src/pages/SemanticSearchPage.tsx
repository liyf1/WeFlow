import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, Pause, Play, RefreshCw, RotateCcw, Search, Sparkles } from 'lucide-react'
import type {
  SemanticIndexStatus,
  SemanticLocations,
  SemanticSearchConfig,
  SemanticSearchHit,
} from '../../electron/services/semantic/types'
import './SemanticSearchPage.scss'

const PHASE_LABEL: Record<SemanticIndexStatus['phase'], string> = {
  idle: '空闲',
  'preparing-model': '正在准备嵌入模型',
  indexing: '正在建立索引',
  paused: '已暂停',
  error: '出错',
}

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toTimestamp(date: string, endOfDay: boolean): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const value = new Date(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime()
  return Number.isNaN(value) ? undefined : Math.floor(value / 1000)
}

export default function SemanticSearchPage() {
  const navigate = useNavigate()
  const api = window.electronAPI.semantic
  const [config, setConfig] = useState<SemanticSearchConfig | null>(null)
  const [status, setStatus] = useState<SemanticIndexStatus | null>(null)
  const [query, setQuery] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [includeGroups, setIncludeGroups] = useState(true)
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<SemanticSearchHit[] | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [sessionNames, setSessionNames] = useState<Map<string, string>>(new Map())
  const [locations, setLocations] = useState<SemanticLocations | null>(null)
  const [remoteHostDraft, setRemoteHostDraft] = useState('')

  useEffect(() => {
    void api.getConfig().then((value) => {
      setConfig(value)
      setRemoteHostDraft(value.modelRemoteHost)
    })
    void api.getStatus().then(setStatus)
    void api.getLocations().then(setLocations)
    const off = api.onStatus(setStatus)
    void window.electronAPI.chat.getSessions().then((result) => {
      const map = new Map<string, string>()
      for (const session of result?.sessions || []) map.set(session.username, session.displayName || session.username)
      setSessionNames(map)
    }).catch(() => undefined)
    return off
  }, [api])

  const updateConfig = useCallback(async (patch: Partial<SemanticSearchConfig>) => {
    const next = await api.setConfig(patch)
    setConfig(next)
    setLocations(await api.getLocations())
  }, [api])

  const chooseDirectory = useCallback(async (key: 'indexDir' | 'modelDir', title: string) => {
    const result = await window.electronAPI.dialog.openDirectory({
      title,
      defaultPath: key === 'indexDir' ? locations?.indexDir : locations?.modelDir,
    })
    const selected = result.canceled ? '' : result.filePaths[0]
    if (!selected) return
    const message = key === 'indexDir'
      ? '索引将改存到新目录，并在新目录中重新建立（旧目录中的索引文件不会删除）。继续吗？'
      : '模型将从新目录加载；若新目录中没有模型，会重新下载。继续吗？'
    if (!window.confirm(message)) return
    await updateConfig({ [key]: selected })
  }, [locations, updateConfig])

  const runSearch = useCallback(async () => {
    const text = query.trim()
    if (!text) return
    setSearching(true)
    setError('')
    setNotice('')
    try {
      const result = await api.search({
        query: text,
        beginTs: toTimestamp(startDate, false),
        endTs: toTimestamp(endDate, true),
        includeGroups,
        topK: 20,
      })
      if (!result.success) {
        setError(result.error || '检索失败')
        setHits(null)
        return
      }
      setHits(result.hits || [])
      setNotice(result.notice || '')
    } finally {
      setSearching(false)
    }
  }, [api, query, startDate, endDate, includeGroups])

  const jumpTo = useCallback((hit: SemanticSearchHit) => {
    const params = new URLSearchParams({
      sessionId: hit.sessionId,
      jumpLocalId: String(hit.firstLocalId),
      jumpCreateTime: String(hit.startTs),
      jumpSource: 'footprint',
    })
    navigate(`/chat?${params.toString()}`)
  }, [navigate])

  const progress = useMemo(() => {
    if (!status || status.totalSessions <= 0) return 0
    return Math.round((status.doneSessions / status.totalSessions) * 100)
  }, [status])

  const busy = status?.phase === 'indexing' || status?.phase === 'preparing-model'

  return (
    <div className="semantic-search-page">
      <header className="semantic-header">
        <div className="semantic-title">
          <Sparkles size={22} />
          <h1>语义检索</h1>
        </div>
        <p className="semantic-subtitle">
          用自然语言描述你要找的对话，不必记得原话。索引和嵌入模型都在本机运行。
        </p>
      </header>

      <section className="semantic-card">
        <div className="semantic-row">
          <label className="semantic-switch">
            <input
              type="checkbox"
              checked={config?.enabled === true}
              onChange={(event) => void updateConfig({ enabled: event.target.checked })}
            />
            <span>开启语义检索</span>
          </label>
          <label className="semantic-field">
            <span>嵌入模型</span>
            <select
              value={config?.embeddingMode || 'standard'}
              onChange={(event) => void updateConfig({ embeddingMode: event.target.value as SemanticSearchConfig['embeddingMode'] })}
            >
              <option value="standard">标准（bge-small-zh，速度快）</option>
              <option value="precise">高精度（bge-m3，较慢）</option>
            </select>
          </label>
          <label className="semantic-switch">
            <input
              type="checkbox"
              checked={config?.includeGroups !== false}
              onChange={(event) => void updateConfig({ includeGroups: event.target.checked })}
            />
            <span>索引群聊</span>
          </label>
        </div>

        <div className="semantic-locations">
          <div className="semantic-location">
            <span className="semantic-location-label">索引目录</span>
            <code title={locations?.indexFile}>{locations?.indexDir || '…'}</code>
            <button type="button" onClick={() => void chooseDirectory('indexDir', '选择索引目录')}><FolderOpen size={14} />更改</button>
            {config?.indexDir && (
              <button type="button" title="恢复默认目录" onClick={() => void updateConfig({ indexDir: '' })}><RotateCcw size={14} /></button>
            )}
            {locations?.indexDir && (
              <button type="button" onClick={() => void window.electronAPI.shell.openPath(locations.indexDir)}>打开</button>
            )}
          </div>
          <div className="semantic-location">
            <span className="semantic-location-label">模型目录</span>
            <code>{locations?.modelDir || '…'}</code>
            <button type="button" onClick={() => void chooseDirectory('modelDir', '选择模型目录')}><FolderOpen size={14} />更改</button>
            {config?.modelDir && (
              <button type="button" title="恢复默认目录" onClick={() => void updateConfig({ modelDir: '' })}><RotateCcw size={14} /></button>
            )}
            {locations?.modelDir && (
              <button type="button" onClick={() => void window.electronAPI.shell.openPath(locations.modelDir)}>打开</button>
            )}
          </div>
          {locations?.bundledModelDir && (
            <div className="semantic-muted">已检测到安装包内置模型，无需联网下载。</div>
          )}
          <div className="semantic-location">
            <span className="semantic-location-label">下载源</span>
            <input
              className="semantic-text-input"
              value={remoteHostDraft}
              onChange={(event) => setRemoteHostDraft(event.target.value)}
              onBlur={() => {
                const value = remoteHostDraft.trim()
                if (value && value !== config?.modelRemoteHost) void updateConfig({ modelRemoteHost: value })
              }}
              placeholder="https://hf-mirror.com/"
            />
          </div>
          <div className="semantic-muted">
            离线使用：把模型文件放到「模型目录/{'<模型ID>'}/」下（如 Xenova/bge-small-zh-v1.5/config.json、tokenizer.json、onnx/model_quantized.onnx）。
          </div>
        </div>

        {config?.enabled && status && (
          <div className="semantic-status">
            <div className="semantic-status-line">
              {busy && <Loader2 size={14} className="semantic-spin" />}
              <span>{PHASE_LABEL[status.phase]}</span>
              {status.phase === 'preparing-model' && typeof status.modelProgress === 'number' && (
                <span>模型下载 {status.modelProgress}%</span>
              )}
              {status.totalSessions > 0 && (
                <span>会话 {status.doneSessions}/{status.totalSessions}（{progress}%）</span>
              )}
              <span>片段 {status.chunkCount}</span>
              {status.currentSession && <span className="semantic-muted">当前：{status.currentSession}</span>}
            </div>
            {status.totalSessions > 0 && (
              <div className="semantic-progress"><div style={{ width: `${progress}%` }} /></div>
            )}
            {status.error && <div className="semantic-error">{status.error}</div>}
            <div className="semantic-actions">
              {status.phase === 'paused'
                ? <button type="button" onClick={() => void api.resume().then(setStatus)}><Play size={14} />继续</button>
                : <button type="button" disabled={!busy} onClick={() => void api.pause().then(setStatus)}><Pause size={14} />暂停</button>}
              <button type="button" disabled={busy} onClick={() => void api.sync().then(setStatus)}><RefreshCw size={14} />立即更新</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (window.confirm('将删除当前账号的语义索引并从头重建，确定吗？')) void api.rebuild().then(setStatus)
                }}
              >
                重建索引
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="semantic-card">
        <form
          className="semantic-search-form"
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch()
          }}
        >
          <div className="semantic-search-input">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：去年和朋友讨论换工作的那次聊天"
              disabled={!config?.enabled}
            />
          </div>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="开始日期" />
          <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="结束日期" />
          <label className="semantic-switch">
            <input type="checkbox" checked={includeGroups} onChange={(event) => setIncludeGroups(event.target.checked)} />
            <span>含群聊</span>
          </label>
          <button type="submit" disabled={!config?.enabled || searching || !query.trim()}>
            {searching ? <Loader2 size={14} className="semantic-spin" /> : <Search size={14} />}
            检索
          </button>
        </form>

        {notice && <div className="semantic-notice">{notice}</div>}
        {error && <div className="semantic-error">{error}</div>}

        {hits && hits.length === 0 && <div className="semantic-empty">没有找到相关对话</div>}
        {hits && hits.length > 0 && (
          <ul className="semantic-results">
            {hits.map((hit) => {
              const [, ...lines] = hit.text.split('\n')
              return (
                <li key={hit.chunkId}>
                  <button type="button" className="semantic-hit" onClick={() => jumpTo(hit)}>
                    <div className="semantic-hit-meta">
                      <strong>{sessionNames.get(hit.sessionId) || hit.sessionId}</strong>
                      <span>{formatTime(hit.startTs)}</span>
                      {hit.isGroup && <span className="semantic-tag">群聊</span>}
                      {hit.matchedBy.map((route) => (
                        <span key={route} className="semantic-tag">{route === 'vector' ? '语义' : '关键词'}</span>
                      ))}
                    </div>
                    <div className="semantic-hit-text">
                      {lines.slice(0, 8).map((line, index) => <p key={index}>{line}</p>)}
                      {lines.length > 8 && <p className="semantic-muted">……</p>}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
