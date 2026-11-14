import { useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import type { AskAnswer } from '../lib/bridge'

interface Props {
  question: string
  answer: AskAnswer | null
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenSource: (path: string) => void
}

/** 极简 Markdown：只处理 **粗体**、`代码` 与 "- " 列表 */
function inline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<code key={`c${key++}`}>{token.slice(1, -1)}</code>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderAnswer(text: string) {
  const lines = text.split('\n')
  return lines.map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return <div key={index} style={{ height: 8 }} />
    if (/^[-*]\s+/.test(trimmed)) {
      return (
        <div key={index} className="ask__line ask__line--bullet">
          <span className="ask__bullet" aria-hidden />
          <span>{inline(trimmed.replace(/^[-*]\s+/, ''))}</span>
        </div>
      )
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const [, num, rest] = trimmed.match(/^(\d+)[.)]\s+(.*)$/) ?? []
      return (
        <div key={index} className="ask__line ask__line--bullet">
          <span className="ask__bullet ask__bullet--num">{num}</span>
          <span>{inline(rest ?? trimmed)}</span>
        </div>
      )
    }
    return (
      <div key={index} className="ask__line">
        {inline(trimmed)}
      </div>
    )
  })
}

/** AI 问答面板：展示答案与引用来源，来源可展开片段 */
export function AskPanel({ question, answer, loading, error, onClose, onOpenSource }: Props) {
  const [openSource, setOpenSource] = useState<string | null>(null)

  return (
    <div className="ask">
      <div className="ask__head">
        <span className="ask__badge">
          <Sparkles size={13} strokeWidth={1.9} />
          AI 回答
        </span>
        <span className="ask__q" title={question}>
          {question}
        </span>
        <button type="button" className="iconbtn" aria-label="关闭问答" onClick={onClose}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      <div className="ask__body">
        {loading && (
          <div className="ask__empty">
            <Loader2 size={16} strokeWidth={1.8} style={{ animation: 'aura-spin 900ms linear infinite' }} />
            正在检索资料并生成回答…
          </div>
        )}

        {!loading && error && <div className="ask__error">{error}</div>}

        {!loading && answer && (
          <>
            <div className="ask__answer">{renderAnswer(answer.answer)}</div>
            <div className="ask__meta">
              {answer.sources.length} 段资料 · {answer.chars.toLocaleString('zh-CN')} 字符 · {answer.model}
            </div>
            <div className="ask__sources">
              {answer.sources.map((source, index) => (
                <div key={source.path} className="ask__source">
                  <button
                    type="button"
                    className="ask__source-head"
                    onClick={() => setOpenSource(openSource === source.path ? null : source.path)}
                  >
                    <span className="ask__source-index">[{index + 1}]</span>
                    <span className="ask__source-name" title={source.path}>
                      {source.name}
                    </span>
                  </button>
                  {openSource === source.path && (
                    <>
                      <div className="ask__source-snippet">{source.snippet}</div>
                      <button type="button" className="linkbtn" onClick={() => onOpenSource(source.path)}>
                        打开文件
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
