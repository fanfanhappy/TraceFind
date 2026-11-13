import { Download, FileQuestion, Folder, Monitor, SearchX, Settings2 } from 'lucide-react'

const ICON_BY_NAME: Record<string, typeof Folder> = {
  桌面: Monitor,
  Desktop: Monitor,
  下载: Download,
  Downloads: Download,
  文档: Folder,
  Documents: Folder,
}

function labelOf(root: string) {
  const segments = root.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? root
}

export function NoResults({ query }: { query: string }) {
  return (
    <div className="empty panel">
      <span className="empty__mark" aria-hidden>
        <FileQuestion size={20} strokeWidth={1.6} />
      </span>
      <strong>没有找到「{query}」</strong>
      <small>试试更短的关键词、文件类型后缀，或换用拼音首字母（例如 cwbg 命中“财务报告”）。</small>
    </div>
  )
}

/** 索引里一条都没有时的引导，避免新用户面对空列表 */
export function EmptyIndex({ onScan }: { onScan: () => void }) {
  return (
    <div className="empty panel">
      <span className="empty__mark" aria-hidden>
        <SearchX size={20} strokeWidth={1.6} />
      </span>
      <strong>索引还是空的</strong>
      <small>先在设置里确认扫描范围，然后建立索引。只读取文件名与路径，不读文件内容。</small>
      <button type="button" className="linkbtn linkbtn--primary" style={{ marginTop: 8 }} onClick={onScan}>
        开始建立索引
      </button>
    </div>
  )
}

interface QuickProps {
  roots: string[]
  scope: string | null
  onToggleScope: (root: string) => void
  onOpenSettings: () => void
}

/** 空查询时的常用位置与快捷操作；位置同时充当搜索范围开关 */
export function QuickActions({ roots, scope, onToggleScope, onOpenSettings }: QuickProps) {
  return (
    <div className="quickrow" role="group" aria-label="常用位置与快捷操作">
      {roots.slice(0, 3).map((root) => {
        const label = labelOf(root)
        const Icon = ICON_BY_NAME[label] ?? Folder
        const active = scope === root
        return (
          <button
            key={root}
            type="button"
            className="chip interactive"
            aria-pressed={active}
            title={active ? `取消范围：${root}` : `只在这个目录里搜：${root}`}
            onClick={() => onToggleScope(root)}
          >
            <Icon size={13} strokeWidth={1.75} />
            {label}
          </button>
        )
      })}
      <button type="button" className="chip interactive" onClick={onOpenSettings}>
        <Settings2 size={13} strokeWidth={1.75} />
        设置
      </button>
    </div>
  )
}
