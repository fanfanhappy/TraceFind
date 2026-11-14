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
import { displayDir, formatModified, formatSize, highlight, type FileKind, type SearchHit } from '../lib/files'

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

interface RowProps {
  file: SearchHit
  index: number
  active: boolean
  query: string
  onHover: (index: number) => void
  onActivate: (index: number) => void
  onPreview: (index: number) => void
  onReveal: (index: number) => void
  roots: string[]
}

function Row({ file, index, active, query, onHover, onActivate, onPreview, onReveal, roots }: RowProps) {
  const Icon = ICONS[file.kind] ?? File
  const name = highlight(file.name, query)
  const dir = highlight(displayDir(file.dir, roots), query)

  return (
    <div
      id={`result-${index}`}
      role="option"
      aria-selected={active}
      className="result"
      onMouseMove={() => onHover(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onActivate(index)}
      onAuxClick={(event) => {
        if (event.button === 1) onPreview(index)
      }}
    >
      <span className="result__icon" data-kind={file.kind} aria-hidden>
        <Icon size={17} strokeWidth={1.75} />
      </span>

      <span className="result__text">
        <span className="result__name" title={file.name}>
          {name.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
        </span>
        {/* 第二行只占一行：有正文片段就显示片段，否则显示目录，避免行高抖动 */}
        <span className={file.snippet ? 'result__snippet' : 'result__path'} title={file.path}>
          {file.snippet
            ? highlight(file.snippet, query).map((part, i) =>
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
        <span className="result__action">
          <kbd>Enter</kbd>
          <span>打开</span>
          <span
            role="button"
            tabIndex={-1}
            title="预览  Ctrl+Space"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onPreview(index)
            }}
          >
            <kbd>Space</kbd>
            <span>预览</span>
          </span>
          <span
            role="button"
            tabIndex={-1}
            title="打开所在文件夹  Ctrl+Enter"
            style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--text-subtle)' }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onReveal(index)
            }}
          >
            定位
          </span>
        </span>
      </span>
    </div>
  )
}

interface ListProps {
  files: SearchHit[]
  activeIndex: number
  query: string
  onHover: (index: number) => void
  onActivate: (index: number) => void
  onPreview: (index: number) => void
  onReveal: (index: number) => void
  roots: string[]
}

/** 05｜搜索结果状态：上下键选择、Enter 打开、Space 预览、Esc 关闭 */
export function ResultsList({ files, activeIndex, query, onHover, onActivate, onPreview, onReveal, roots }: ListProps) {
  return (
    <div
      className="results"
      id="results"
      role="listbox"
      aria-label={query ? '搜索结果' : '最近使用'}
      aria-activedescendant={activeIndex >= 0 ? `result-${activeIndex}` : undefined}
      tabIndex={0}
    >
      {files.map((file, index) => (
        <Row
          key={file.path}
          file={file}
          index={index}
          active={index === activeIndex}
          query={query}
          onHover={onHover}
          onActivate={onActivate}
          onPreview={onPreview}
          onReveal={onReveal}
          roots={roots}
        />
      ))}
    </div>
  )
}
