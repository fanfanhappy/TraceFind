import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderOpen, Loader2, X } from 'lucide-react'
import { previewFile, type PreviewPayload } from '../lib/bridge'
import { formatModified, formatSize, type SearchHit } from '../lib/files'
import { languageFor, tokenize } from '../lib/highlight'

interface Props {
  file: SearchHit | null
  query: string
  onClose: () => void
  onOpen: (file: SearchHit) => void
  onReveal: (file: SearchHit) => void
}

interface Piece {
  text: string
  hit: boolean
}

/** 只标记前若干处命中，避免长文档里高频词生成上万个节点 */
function markPieces(text: string, query: string, maxMarks = 200): Piece[] {
  const parts: Piece[] = []
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  let from = 0
  let marks = 0
  while (marks < maxMarks) {
    const found = lower.indexOf(needle, from)
    if (found < 0) break
    if (found > from) parts.push({ text: text.slice(from, found), hit: false })
    parts.push({ text: text.slice(found, found + needle.length), hit: true })
    from = found + needle.length
    marks += 1
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts
}

/**
 * 05｜快速预览：文本类分页加载（每页 6 万字符），代码类做轻量语法高亮，
 * 命中词仍会高亮并滚动到第一处。
 */
export function PreviewDrawer({ file, query, onClose, onOpen, onReveal }: Props) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [text, setText] = useState('')
  const [nextStart, setNextStart] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [paging, setPaging] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    if (!file) {
      setPayload(null)
      setText('')
      setNextStart(null)
      return
    }
    setLoading(true)
    setText('')
    setNextStart(null)
    void previewFile(file.path).then((next) => {
      if (!alive || !next) return
      setPayload(next)
      setText(next.text ?? '')
      setNextStart(next.nextStart ?? null)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [file?.path])

  const language = payload?.language ? languageFor(payload.language) ?? payload.language : null
  const isCode = Boolean(language) && language !== 'markdown'

  const codeTokens = useMemo(() => {
    if (!isCode || !text) return null
    return tokenize(text, language as string)
  }, [isCode, language, text])

  const pieces = useMemo(() => {
    if (isCode) return null
    return markPieces(text, query)
  }, [isCode, text, query])

  // 命中滚动：普通文本滚到第一处 mark；代码按行查找
  useEffect(() => {
    if (loading) return
    if (isCode) {
      const needle = query.trim()
      if (!needle) return
      const target = bodyRef.current?.querySelector('[data-hit="true"]')
      target?.scrollIntoView({ block: 'center' })
      return
    }
    const mark = bodyRef.current?.querySelector('mark')
    mark?.scrollIntoView({ block: 'center' })
  }, [text, query, isCode, loading])

  if (!file) return null

  const loadMore = () => {
    if (nextStart === null || paging) return
    setPaging(true)
    void previewFile(file.path, nextStart).then((next) => {
      if (!next) return
      setText((current) => current + (next.text ?? ''))
      setNextStart(next.nextStart ?? null)
      setPaging(false)
    })
  }

  return (
    <aside className="drawer preview" aria-label="快速预览">
      <div className="drawer__head">
        <span className="preview__title" title={file.path}>
          {file.name}
        </span>
        <button type="button" className="iconbtn" title="关闭预览  Esc" aria-label="关闭预览" onClick={onClose}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      <div className="preview__meta">
        <span>{file.kind === 'folder' ? '文件夹' : formatSize(file.size) || '—'}</span>
        <span>{formatModified(file.modified)}</span>
        {payload?.totalChars ? <span>{payload.totalChars.toLocaleString('zh-CN')} 字符</span> : null}
      </div>

      <div className="preview__body" ref={bodyRef}>
        {loading && (
          <div className="preview__empty">
            <Loader2 size={16} strokeWidth={1.8} style={{ animation: 'aura-spin 900ms linear infinite' }} />
            正在读取…
          </div>
        )}

        {!loading && payload?.kind === 'text' && (
          <pre className={isCode ? 'preview__text preview__text--code' : 'preview__text'}>
            {codeTokens
              ? codeTokens.map((token, index) => (
                  <span
                    key={index}
                    className={token.kind === 'plain' ? undefined : `tok tok--${token.kind}`}
                    data-hit={query.trim() && token.text.includes(query.trim()) ? 'true' : undefined}
                  >
                    {token.text}
                  </span>
                ))
              : pieces?.map((part, index) =>
                  part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                )}
          </pre>
        )}

        {!loading && payload?.kind === 'image' && payload.imageDataUrl && (
          <img className="preview__image" src={payload.imageDataUrl} alt={file.name} />
        )}

        {!loading && payload && payload.kind !== 'text' && payload.kind !== 'image' && (
          <div className="preview__empty">
            <span>{payload.message ?? '这个文件暂时无法预览'}</span>
            <span style={{ color: 'var(--text-subtle)' }}>用外部程序打开可以看到完整内容</span>
          </div>
        )}
      </div>

      {payload?.kind === 'text' && nextStart !== null && (
        <div className="preview__more">
          <button type="button" className="linkbtn" onClick={loadMore} disabled={paging}>
            {paging ? '正在加载…' : '加载更多'}
          </button>
          <span>{nextStart.toLocaleString('zh-CN')} / {payload.totalChars?.toLocaleString('zh-CN') ?? '?'}</span>
        </div>
      )}

      <div className="preview__footer">
        <button type="button" className="linkbtn" onClick={() => onOpen(file)}>
          <ExternalLink size={12} strokeWidth={1.9} />
          打开
        </button>
        <button type="button" className="linkbtn" onClick={() => onReveal(file)}>
          <FolderOpen size={12} strokeWidth={1.9} />
          定位
        </button>
      </div>
    </aside>
  )
}
