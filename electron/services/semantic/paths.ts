import { join } from 'path'

export function sanitizeAccountId(accountId: string): string {
  return String(accountId || '').trim().replace(/[^a-zA-Z0-9_.@-]/g, '_') || 'default'
}

/** 每个微信账号一个独立索引文件：<userData>/semantic-index/<accountId>.db */
export function getSemanticIndexPath(userDataPath: string, accountId: string): string {
  return join(userDataPath, 'semantic-index', `${sanitizeAccountId(accountId)}.db`)
}
