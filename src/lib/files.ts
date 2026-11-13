// 搜索结果模型与展示工具。
// 模块二起数据来自 Rust 侧的 SQLite 索引（见 src/lib/bridge.ts）；
// 浏览器预览（pnpm dev:web）没有后端，退化为下面这组演示条目。

export type FileKind =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'image'
  | 'archive'
  | 'video'
  | 'audio'
  | 'code'
  | 'binary'
  | 'other'
  | 'folder'

export interface SearchHit {
  path: string
  name: string
  dir: string
  ext: string
  kind: FileKind
  /** 字节数，目录为 0 */
  size: number
  /** Unix 秒 */
  modified: number
  /** 正文命中片段（未建立内容索引时为空） */
  snippet?: string | null
}

export const demoHits: SearchHit[] = [
  {
    path: 'C:\\Users\\demo\\Documents\\示例\\季度预算报告.docx',
    name: '季度预算报告.docx',
    dir: 'C:\\Users\\demo\\Documents\\示例',
    ext: 'docx',
    kind: 'doc',
    size: 1_546_421,
    modified: Math.floor(Date.now() / 1000) - 900,
  },
  {
    path: 'C:\\Users\\demo\\Documents\\示例\\产品需求说明.docx',
    name: '产品需求说明.docx',
    dir: 'C:\\Users\\demo\\Documents\\示例',
    ext: 'docx',
    kind: 'doc',
    size: 1_540_000,
    modified: Math.floor(Date.now() / 1000) - 2400,
  },
  {
    path: 'C:\\Users\\demo\\Documents\\示例\\会议纪要.md',
    name: '会议纪要.md',
    dir: 'C:\\Users\\demo\\Documents\\示例',
    ext: 'md',
    kind: 'code',
    size: 12_288,
    modified: Math.floor(Date.now() / 1000) - 86_400,
  },
]

export interface HighlightPart {
  text: string
  hit: boolean
}

/** 把命中关键词切成高亮片段（后端只做匹配，不做分段） */
export function highlight(text: string, query: string): HighlightPart[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(term => term.length > 0)
    .map(term => term.toLowerCase())
  if (terms.length === 0) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let from = 0
    while (from <= lower.length - term.length) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      ranges.push([at, at + term.length])
      from = at + term.length
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }]

  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }

  const parts: HighlightPart[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false })
    parts.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
  return parts
}

export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** 今天/昨天用相对时间，其余用日期，避免列表里出现大段绝对时间 */
export function formatModified(epochSeconds: number): string {
  if (!epochSeconds) return ''
  const date = new Date(epochSeconds * 1000)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000)

  if (dayDiff === 0) return `今天 ${time}`
  if (dayDiff === 1) return `昨天 ${time}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 目录路径缩成 "…/父目录"，保留可辨识的尾部 */
export function shortenDir(dir: string, maxSegments = 3): string {
  const segments = dir.split(/[\\/]/).filter(Boolean)
  if (segments.length <= maxSegments) return segments.join(' / ')
  return `… / ${segments.slice(-maxSegments).join(' / ')}`
}

function rootLabel(root: string): string {
  const segments = root.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? root
}

/**
 * 结果行里的位置：落在扫描范围内就显示「Documents / 子目录」，
 * 否则退化成尾部若干段，避免出现一长串绝对路径噪音。
 */
export function displayDir(dir: string, roots: string[]): string {
  const normalized = dir.replace(/\\/g, '/')
  for (const root of roots) {
    const base = root.replace(/\\/g, '/').replace(/\/$/, '')
    if (normalized === base) return rootLabel(root)
    if (normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      const rest = normalized.slice(base.length + 1)
      return `${rootLabel(root)} / ${rest.split('/').join(' / ')}`
    }
  }
  return shortenDir(dir)
}
