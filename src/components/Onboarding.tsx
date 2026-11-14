import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, FolderPlus, Loader2, Sparkles } from 'lucide-react'
import { BrandMark } from './BrandMark'
import {
  completeOnboarding,
  pickFolders,
  suggestedRoots,
  type AppSettings,
} from '../lib/bridge'

interface Props {
  settings: AppSettings
  /** 实际注册成功的快捷键（配置被占用时会降级） */
  hotkey: string
  onDone: (next: AppSettings, skipped: boolean) => void
}

function labelOf(path: string) {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}

/** 首次使用：三步引导（欢迎 → 选目录 → 完成），带入场动画 */
export function Onboarding({ settings, hotkey, onDone }: Props) {
  const [step, setStep] = useState(0)
  const [suggested, setSuggested] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>(settings.roots)
  const [custom, setCustom] = useState<string[]>(settings.roots)
  const [loadingRoots, setLoadingRoots] = useState(true)
  const dialog = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void suggestedRoots().then((roots) => {
      if (!alive) return
      setSuggested(roots)
      if (!settings.roots.length) setPicked(roots)
    }).catch(() => {
      if (alive) setError("无法读取推荐目录，请手动添加文件夹。")
    }).finally(() => {
      if (alive) setLoadingRoots(false)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    dialog.current?.querySelector('h2')?.focus()
  }, [step])

  const toggle = (root: string) =>
    setPicked((current) =>
      current.some((item) => item.toLowerCase() === root.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== root.toLowerCase())
        : [...current, root],
    )

  const addFolder = useCallback(async () => {
    setError('')
    try {
      const roots = await pickFolders()
      if (!roots.length) return
      const append = (current: string[]) => {
        const next = [...current]
        for (const root of roots) {
          if (!next.some((item) => item.toLowerCase() === root.toLowerCase())) next.push(root)
        }
        return next
      }
      setCustom(append)
      setPicked(append)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const finish = useCallback(
    async (roots: string[]) => {
      setBusy(true)
      setError('')
      try {
        const next = await completeOnboarding(roots)
        onDone(next, roots.length === 0)
      } catch (err) {
        setError(String(err))
        setBusy(false)
      }
    },
    [onDone],
  )

  const reduce = settings.reducedMotion
  const folders = [...new Map([...suggested, ...custom].map((root) => [root.toLowerCase(), root])).values()]
  const indexing = settings.roots.length && settings.contentIndex
    ? (settings.ocrEnabled ? '文件名、正文和 OCR' : '文件名和正文')
    : '文件名与路径'
  const chosen = useMemo(() => picked.filter(Boolean), [picked])

  return (
    <div ref={dialog} aria-modal="true" className="onboarding" data-reduce={reduce ? 'true' : undefined} role="dialog" aria-label="首次使用引导">
      <div className="onboarding__steps" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span key={index} className="onboarding__dot" data-on={index === step ? 'true' : undefined} />
        ))}
      </div>

      {step === 0 && (
        <div className="onboarding__panel" key="welcome">
          <span className="onboarding__mark" aria-hidden>
            <BrandMark size={44} />
          </span>
          <h2 tabIndex={-1} className="onboarding__title">TraceFind</h2>
          <p className="onboarding__lead">忘了文件名，记得一点也能找。</p>
          <ul className="onboarding__points">
            <li>文件名、拼音、正文，一个框全搜</li>
            <li>不打开文件就能预览内容</li>
            <li>记不住原词，也可以直接问</li>
          </ul>
          <div className="onboarding__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setStep(1)}>
              开始
              <ArrowRight size={14} strokeWidth={2} />
            </button>
            <button type="button" className="linkbtn" disabled={busy} onClick={() => void finish([])}>
              跳过
            </button>
          </div>
          {error && <small role="alert" className="onboarding__hint onboarding__hint--error">{error}</small>}
        </div>
      )}

      {step === 1 && (
        <div className="onboarding__panel" key="folders">
          <h2 tabIndex={-1} className="onboarding__title onboarding__title--sm">要搜哪些文件夹？</h2>
          <p className="onboarding__lead">当前将索引{indexing}。之后可在设置里调整。</p>

          <div className="onboarding__grid">
            {folders.map((root) => {
              const active = chosen.some((item) => item.toLowerCase() === root.toLowerCase())
              return (
                <button
                  key={root}
                  type="button"
                  className="onboarding__root"
                  aria-pressed={active}
                  disabled={loadingRoots}
                  onClick={() => toggle(root)}
                >
                  <span className="onboarding__check" aria-hidden>
                    {active && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="onboarding__rootname">{labelOf(root)}</span>
                  <span className="onboarding__rootpath" title={root}>
                    {root}
                  </span>
                </button>
              )
            })}

            <button type="button" className="onboarding__root onboarding__root--add" disabled={loadingRoots} onClick={() => void addFolder()}>
              <span className="onboarding__check" aria-hidden>
                <FolderPlus size={13} strokeWidth={2} />
              </span>
              <span className="onboarding__rootname">添加其他文件夹</span>
              <span className="onboarding__rootpath">从资源管理器里选</span>
            </button>
          </div>

          <div className="onboarding__actions">
            <button type="button" className="btn" onClick={() => setStep(0)}>
              上一步
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={loadingRoots || chosen.length === 0 || busy}
              onClick={() => setStep(2)}
            >
              下一步
              <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
          {chosen.length === 0 && <small className="onboarding__hint">至少选一个文件夹</small>}
          {error && <small role="alert" className="onboarding__hint onboarding__hint--error">{error}</small>}
        </div>
      )}

      {step === 2 && (
        <div className="onboarding__panel" key="ready">
          <span className="onboarding__mark onboarding__mark--glow" aria-hidden>
            <Sparkles size={30} strokeWidth={1.7} />
          </span>
          <h2 tabIndex={-1} className="onboarding__title onboarding__title--sm">可以开始了</h2>
          <p className="onboarding__lead">
            已选 {chosen.length} 个文件夹，将索引{indexing}。
          </p>

          <div className="onboarding__keys">
            <span>
              <kbd>{hotkey}</kbd>
              随时唤起
            </span>
            <span>
              <kbd>Enter</kbd>
              打开
            </span>
            <span>
              <kbd>Ctrl + Space</kbd>
              预览
            </span>
          </div>

          <div className="onboarding__actions">
            <button type="button" className="btn" onClick={() => setStep(1)} disabled={busy}>
              上一步
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void finish(chosen)} disabled={busy}>
              {busy ? <Loader2 size={14} strokeWidth={2} className="spin" /> : <Check size={14} strokeWidth={2.4} />}
              建立索引并开始
            </button>
          </div>
          {error && <small role="alert" className="onboarding__hint onboarding__hint--error">{error}</small>}
        </div>
      )}
    </div>
  )
}
