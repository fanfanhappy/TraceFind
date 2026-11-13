import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { AskAnswer } from '../lib/bridge'

interface Props {
  question: string
  answer: AskAnswer | null
  loading: boolean
  error: string | null
  onClose: () => void
  onOpenSource: (path: string) => void
}

/** AI 问答面板：展示答案与引用来源，来源可点开预览 */
export function AskPanel({ question, answer, loading, error, onClose, onOpenSource }: Props) {
  const [openSource, setOpenSource] = useState<string | null>(null)

  return (
    <div className="ask">
      <div className="ask__head">
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
            <div className="ask__answer">{answer.answer}</div>
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
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => onOpenSource(source.path)}
                      >
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
