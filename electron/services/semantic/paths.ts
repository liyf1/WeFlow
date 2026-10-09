import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { SemanticLocations, SemanticSearchConfig } from './types'

export function sanitizeAccountId(accountId: string): string {
  return String(accountId || '').trim().replace(/[^a-zA-Z0-9_.@-]/g, '_') || 'default'
}

export function defaultIndexDir(userDataPath: string): string {
  return join(userDataPath, 'semantic-index')
}

export function defaultModelDir(userDataPath: string): string {
  return join(userDataPath, 'semantic-models')
}

/** 每个微信账号一个独立索引文件：<indexDir>/<accountId>.db */
export function getSemanticIndexPath(indexDir: string, accountId: string): string {
  return join(indexDir, `${sanitizeAccountId(accountId)}.db`)
}

/**
 * 安装包可能内置的模型目录。目录结构与下载缓存一致：<root>/<modelId>/config.json …
 * 打包后位于 <resources>/resources/models；开发环境位于仓库的 resources/models。
 */
export function findBundledModelDir(modelId: string): string | undefined {
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '')
  const candidates = [
    resourcesPath ? join(resourcesPath, 'resources', 'models') : '',
    join(process.cwd(), 'resources', 'models'),
    join(__dirname, '..', 'resources', 'models'),
  ].filter(Boolean)
  return candidates.find((root) => existsSync(join(root, modelId, 'config.json')))
}

export function resolveSemanticLocations(
  config: Pick<SemanticSearchConfig, 'indexDir' | 'modelDir'>,
  userDataPath: string,
  modelId?: string,
): SemanticLocations {
  return {
    indexDir: config.indexDir || defaultIndexDir(userDataPath),
    modelDir: config.modelDir || defaultModelDir(userDataPath),
    bundledModelDir: modelId ? findBundledModelDir(modelId) : undefined,
  }
}

export interface InstallerSemanticPaths {
  indexDir: string
  modelDir: string
  hash: string
}

/**
 * 读取安装器写入的 <安装目录>/semantic.ini：
 *   [paths]
 *   indexDir=D:\WeFlowData\index
 *   modelDir=D:\WeFlowData\models
 */
export function readInstallerSemanticPaths(exeDir = dirname(process.execPath)): InstallerSemanticPaths | null {
  const file = join(exeDir, 'semantic.ini')
  if (!existsSync(file)) return null
  try {
    return parseInstallerIni(decodeIniBuffer(readFileSync(file)))
  } catch {
    return null
  }
}

/** 安装器以 UTF-16LE（带 BOM）写入，保证中文路径不乱码；也兼容 UTF-8 */
export function decodeIniBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  return buffer.toString('utf8').replace(/^﻿/, '')
}

export function parseInstallerIni(content: string): InstallerSemanticPaths {
  let section = ''
  const values: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase()
      continue
    }
    const index = line.indexOf('=')
    if (index <= 0 || section !== 'paths') continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  const indexDir = values.indexDir || ''
  const modelDir = values.modelDir || ''
  const hash = createHash('sha256').update(`${indexDir}\u0000${modelDir}`).digest('hex').slice(0, 16)
  return { indexDir, modelDir, hash }
}
