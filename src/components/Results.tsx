import { useState } from 'react'
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import {
  cleanSnippet,
  displayDir,
  formatModified,
  formatSize,
  highlight,
  type FileKind,
  type SearchHit,
} from '../lib/files'

const ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileType2,
  doc: FileText,
  sheet: FileSpreadsheet,
  slide: Presentation,
  image: FileImage,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  code: FileCode2,
  binary: File,
  other: File,
  folder: Folder,
}

/** 只在"不是靠文件名命中"时标注来源，避免每行都堆标签 */
function sourceTag(file: SearchHit): string | null {
  const sources = file.sources ?? []
  if (sources.includes('semantic')) return '语义'
  // 文件名已经对上了就不需要解释，只有"不是靠文件名"才标来源
  if (sources.includes('name')) return null
  if (sources.includes('content')) return '正文'
  return null
}

interface RowProps {
  file: SearchHit
  index: number
  active: boolean
  hovered: boolean
  query: string
  onHover: (index: number) => void
  onLeave: () => void
  onSelect: (index: number) => void
  onActivate: (index: number) => void
  onPreview: (index: number) => void
  roots: string[]
}

function Row({ file, index, active, hovered, query, onHover, onLeave, onSelect, onActivate, onPreview, roots }: RowProps) {
  const Icon = ICONS[file.kind] ?? File
  const name = highlight(file.name, query)
  const dir = highlight(displayDir(file.dir, roots), query)
  const tag = sourceTag(file)
  const snippet = file.snippet ? cleanSnippet(file.snippet) : null

  return (
    <div
      id={`result-${index}`}
      role="option"
      aria-selected={active}
      className="result"
      data-hover={hovered ? 'true' : undefined}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={onLeave}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onActivate(index)}
      onAuxClick={(event) => {
        if (event.button === 1) onPreview(index)
      }}
    >
      <span className="result__icon" data-kind={file.kind} aria-hidden>
        <Icon size={17} strokeWidth={1.75} />
      </span>

      <span className="result__text">
        <span className="result__name" title={file.name}>
          {tag && <span className="result__tag">{tag}</span>}
          {name.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
        </span>
        {/* 第二行只占一行：有正文片段就显示片段，否则显示目录，避免行高抖动 */}
        <span className={snippet ? 'result__snippet' : 'result__path'} title={file.path}>
          {snippet
            ? highlight(snippet, query).map((part, i) =>
                part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
              )
            : dir.map((part, i) =>
                part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
              )}
        </span>
      </span>

      <span className="result__meta">
        <span className="result__size">{file.kind === 'folder' ? '' : formatSize(file.size)}</span>
        <span className="result__time">{formatModified(file.modified)}</span>
      </span>
    </div>
  )
}

interface ListProps {
  files: SearchHit[]
  activeIndex: number
  stale: boolean
  query: string
  onSelect: (index: number) => void
  onActivate: (index: number) => void
  onPreview: (index: number) => void
  roots: string[]
}

export function ResultsList({ files, activeIndex, stale, query, onSelect, onActivate, onPreview, roots }: ListProps) {
  // 悬停只做视觉反馈，不改变键盘选中项
  const [hoverIndex, setHoverIndex] = useState(-1)

  return (
    <div
      className="results"
      id="results"
      role="listbox"
      aria-label={query ? '搜索结果' : '最近使用'}
      aria-activedescendant={activeIndex >= 0 ? `result-${activeIndex}` : undefined}
      data-stale={stale ? 'true' : undefined}
      tabIndex={0}
      onMouseLeave={() => setHoverIndex(-1)}
    >
      {files.map((file, index) => (
        <Row
          key={file.path}
          file={file}
          index={index}
          active={index === activeIndex}
          hovered={index === hoverIndex}
          query={query}
          onHover={setHoverIndex}
          onLeave={() => setHoverIndex(-1)}
          onSelect={onSelect}
          onActivate={onActivate}
          onPreview={onPreview}
          roots={roots}
        />
      ))}
    </div>
  )
}
