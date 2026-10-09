import {
  DEFAULT_CHUNKING_OPTIONS,
  type SemanticChunk,
  type SemanticChunkingOptions,
  type SemanticSourceMessage,
} from './types'

export const SELF_SPEAKER = 'self'

/** 单条消息进入片段文本前的最大字符数，避免一条长文本挤占整个片段 */
const MAX_MESSAGE_CHARS = 300

export interface SemanticChunkerContext {
  sessionId: string
  sessionDisplayName: string
  isGroup: boolean
  /** 群聊中把发言人用户名转换为显示名；私聊可不提供 */
  resolveSenderName?: (username: string) => string
}

interface PendingMessage {
  localId: number
  createTime: number
  speaker: string
  line: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function dayPart(hour: number): string {
  if (hour < 5) return '凌晨'
  if (hour < 9) return '早上'
  if (hour < 12) return '上午'
  if (hour < 14) return '中午'
  if (hour < 18) return '下午'
  return '晚上'
}

export function formatChunkTimeLabel(seconds: number): string {
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${dayPart(date.getHours())}`
}

function normalizeMessageText(value: string): string {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_MESSAGE_CHARS) return compact
  return `${compact.slice(0, MAX_MESSAGE_CHARS)}…`
}

/**
 * 把一个会话的消息流切成对话片段。
 *
 * 消息必须按时间升序推入；可以分多批调用 push，最后调用 flush 取出剩余片段。
 * 规则：
 * 1. 相邻消息间隔超过 gapMinutes 时切开；
 * 2. 片段达到 maxMessages 或 maxChars 时强制切开，并让下一片段重叠 overlapMessages 条；
 * 3. 因时间间隔切开时，若当前片段少于 minMessages 条，则并入前一片段（前提是不超出字数上限的 1.5 倍）。
 */
export class SemanticChunker {
  private readonly options: SemanticChunkingOptions
  private readonly context: SemanticChunkerContext
  private current: PendingMessage[] = []
  private currentChars = 0
  /** 最近一个已完成但仍可能被小片段并入的片段 */
  private held: PendingMessage[] | null = null
  private readonly ready: SemanticChunk[] = []

  constructor(context: SemanticChunkerContext, options: Partial<SemanticChunkingOptions> = {}) {
    this.context = context
    this.options = { ...DEFAULT_CHUNKING_OPTIONS, ...options }
  }

  push(messages: SemanticSourceMessage[]): SemanticChunk[] {
    for (const message of messages) this.pushOne(message)
    return this.drain()
  }

  flush(): SemanticChunk[] {
    this.closeCurrent('end')
    if (this.held) {
      this.ready.push(this.build(this.held))
      this.held = null
    }
    return this.drain()
  }

  private drain(): SemanticChunk[] {
    return this.ready.splice(0, this.ready.length)
  }

  private toPending(message: SemanticSourceMessage): PendingMessage | null {
    const text = normalizeMessageText(message.parsedContent)
    if (!text) return null
    const createTime = Math.floor(Number(message.createTime) || 0)
    if (createTime <= 0) return null
    const isSelf = message.isSend === 1
    const senderUsername = String(message.senderUsername || '').trim()
    let speaker: string
    let speakerName: string
    if (isSelf) {
      speaker = SELF_SPEAKER
      speakerName = '我'
    } else if (this.context.isGroup) {
      speaker = senderUsername || 'unknown'
      speakerName = senderUsername
        ? (this.context.resolveSenderName?.(senderUsername) || senderUsername)
        : '群成员'
    } else {
      speaker = this.context.sessionId
      speakerName = this.context.sessionDisplayName || this.context.sessionId
    }
    return {
      localId: Math.floor(Number(message.localId) || 0),
      createTime,
      speaker,
      line: `${speakerName}：${text}`,
    }
  }

  private pushOne(message: SemanticSourceMessage): void {
    const pending = this.toPending(message)
    if (!pending) return
    const last = this.current.at(-1)
    if (last && pending.createTime - last.createTime > this.options.gapMinutes * 60) {
      this.closeCurrent('gap')
    }
    const nextChars = this.currentChars + pending.line.length + 1
    if (this.current.length > 0 && (
      this.current.length >= this.options.maxMessages
      || nextChars > this.options.maxChars
    )) {
      this.closeCurrent('size')
    }
    this.current.push(pending)
    this.currentChars += pending.line.length + 1
  }

  private closeCurrent(reason: 'gap' | 'size' | 'end'): void {
    if (this.current.length === 0) return
    const finished = this.current
    const overlap = reason === 'size' && this.options.overlapMessages > 0
      ? finished.slice(-this.options.overlapMessages)
      : []
    this.current = [...overlap]
    this.currentChars = overlap.reduce((sum, item) => sum + item.line.length + 1, 0)

    if (finished.length < this.options.minMessages && this.held) {
      const heldChars = this.held.reduce((sum, item) => sum + item.line.length + 1, 0)
      const finishedChars = finished.reduce((sum, item) => sum + item.line.length + 1, 0)
      if (heldChars + finishedChars <= this.options.maxChars * 1.5) {
        this.held = [...this.held, ...finished]
        return
      }
    }
    if (this.held) this.ready.push(this.build(this.held))
    this.held = finished
  }

  private build(messages: PendingMessage[]): SemanticChunk {
    const first = messages[0]
    const last = messages[messages.length - 1]
    const kind = this.context.isGroup ? '群聊' : '私聊'
    const header = `[${kind}·${this.context.sessionDisplayName || this.context.sessionId} · ${formatChunkTimeLabel(first.createTime)}]`
    const speakers = Array.from(new Set(messages.map((item) => item.speaker)))
    return {
      sessionId: this.context.sessionId,
      isGroup: this.context.isGroup,
      startTs: first.createTime,
      endTs: last.createTime,
      firstLocalId: first.localId,
      lastLocalId: last.localId,
      speakers,
      text: `${header}\n${messages.map((item) => item.line).join('\n')}`,
      messageCount: messages.length,
    }
  }
}

/** 便捷函数：一次性切分整段消息 */
export function chunkMessages(
  context: SemanticChunkerContext,
  messages: SemanticSourceMessage[],
  options: Partial<SemanticChunkingOptions> = {},
): SemanticChunk[] {
  const chunker = new SemanticChunker(context, options)
  return [...chunker.push(messages), ...chunker.flush()]
}
