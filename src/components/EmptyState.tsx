import { Download, FileQuestion, Folder, FolderPlus, Monitor, SearchX, Settings2 } from 'lucide-react'

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

export type NoResultReason = 'scanning' | 'content-off' | 'scoped' | 'generic'

interface NoResultsProps {
  query: string
  reason: NoResultReason
  onSearchAll: () => void
  onEnableContent: () => void
  onOpenSettings: () => void
}

/** 无结果时按"已知原因"分档：只陈述当前确实知道的状态，不猜 */
export function NoResults({ query, reason, onSearchAll, onEnableContent, onOpenSettings }: NoResultsProps) {
  if (reason === 'scanning') {
    return (
      <div className="empty panel">
        <span className="empty__mark" aria-hidden>
          <SearchX size={20} strokeWidth={1.6} />
        </span>
        <strong>还在建立索引</strong>
        <small>当前只索引到一部分文件，等扫描完成后「{query}」可能就能搜到。</small>
      </div>
    )
  }

  if (reason === 'content-off') {
    return (
      <div className="empty panel">
        <span className="empty__mark" aria-hidden>
          <FileQuestion size={20} strokeWidth={1.6} />
        </span>
        <strong>没有文件名匹配「{query}」</strong>
        <small>正文索引当前是关闭的——打开后可以搜文档内容，而不只是文件名。</small>
        <button type="button" className="linkbtn linkbtn--primary" style={{ marginTop: 8 }} onClick={onEnableContent}>
          开启正文索引
        </button>
      </div>
    )
  }

  if (reason === 'scoped') {
    return (
      <div className="empty panel">
        <span className="empty__mark" aria-hidden>
          <Folder size={20} strokeWidth={1.6} />
        </span>
        <strong>当前范围里没有「{query}」</strong>
        <small>现在只在这个目录里搜索，换到全部目录可能就有了。</small>
        <button type="button" className="linkbtn linkbtn--primary" style={{ marginTop: 8 }} onClick={onSearchAll}>
          搜索全部目录
        </button>
      </div>
    )
  }

  return (
    <div className="empty panel">
      <span className="empty__mark" aria-hidden>
        <FileQuestion size={20} strokeWidth={1.6} />
      </span>
      <strong>没有找到「{query}」</strong>
      <small>试试更短的关键词、文件类型后缀，或换用拼音首字母（例如 cwbg 命中“财务报告”）。</small>
      <button type="button" className="linkbtn" style={{ marginTop: 8 }} onClick={onOpenSettings}>
        检查索引范围
      </button>
    </div>
  )
}

/** 索引里一条都没有时的引导，避免新用户面对空列表 */
export function EmptyIndex({ onScan, onOpenSettings }: { onScan: () => void; onOpenSettings: () => void }) {
  return (
    <div className="empty panel">
      <span className="empty__mark" aria-hidden>
        <SearchX size={20} strokeWidth={1.6} />
      </span>
      <strong>还没有可搜索的文件</strong>
      <small>先添加要搜索的文件夹，再建立索引。只读取文件名与路径，不读内容。</small>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="linkbtn linkbtn--primary" onClick={onOpenSettings}>
          <FolderPlus size={13} strokeWidth={1.9} />
          添加文件夹
        </button>
        <button type="button" className="linkbtn" onClick={onScan}>
          开始建立索引
        </button>
      </div>
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
      <button type="button" className="chip interactive" onClick={onOpenSettings} title="添加要搜索的文件夹">
        <FolderPlus size={13} strokeWidth={1.75} />
        添加文件夹
      </button>
      <button type="button" className="chip interactive" onClick={onOpenSettings}>
        <Settings2 size={13} strokeWidth={1.75} />
        设置
      </button>
    </div>
  )
}
