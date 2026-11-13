import { useEffect, useState } from 'react'
import { Check, Pencil, RefreshCw, Undo2 } from 'lucide-react'

interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}

export function Switch({ checked, disabled, label, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  label: string
  onChange: (value: T) => void
}

export function Segmented<T extends string>({ value, options, label, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'])

/** 把键盘事件转成 Tauri 快捷键字符串；只按修饰键或单键无修饰时返回 null。 */
export function normalizeAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  if (parts.length === 0) return null

  let key = event.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  else if (key.startsWith('Arrow')) key = key.replace('Arrow', '')
  else if (key === 'Escape') return null
  else key = key[0].toUpperCase() + key.slice(1)

  return [...parts, key].join('+')
}

interface HotkeyProps {
  accel: string
  saving?: boolean
  onCommit: (accel: string) => void
  onReset: () => void
}

/** 快捷键录制：按下组合 → 确认 → 交给 Rust 先验证后替换，失败自动回滚旧组合。 */
export function HotkeyField({ accel, saving, onCommit, onReset }: HotkeyProps) {
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setDraft(null)
        return
      }
      if (event.key === 'Enter' && draft) {
        commit()
        return
      }
      const next = normalizeAccelerator(event)
      if (next) setDraft(next)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, draft, saving])

  function commit() {
    if (!draft || saving) return
    setRecording(false)
    setDraft(null)
    if (draft !== accel) onCommit(draft)
  }

  const shown = recording ? draft : accel

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="hotkey" data-recording={recording} aria-live="polite">
        <span className="hotkey__keys">
          {shown ? (
            shown.split('+').map((part) => <kbd key={part}>{part}</kbd>)
          ) : (
            <span style={{ color: 'var(--text-subtle)' }}>按下组合键…</span>
          )}
        </span>
        {recording ? (
          <>
            <button
              type="button"
              className="hotkey__edit"
              title="确认 (Enter)"
              aria-label="确认快捷键"
              disabled={!draft || saving}
              onClick={commit}
            >
              <Check size={13} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className="hotkey__edit"
              title="取消 (Esc)"
              aria-label="取消录制"
              onClick={() => {
                setRecording(false)
                setDraft(null)
              }}
            >
              <Undo2 size={12} strokeWidth={2} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="hotkey__edit"
            title="修改快捷键"
            aria-label="修改快捷键"
            disabled={saving}
            onClick={() => {
              setDraft(null)
              setRecording(true)
            }}
          >
            <Pencil size={12} strokeWidth={2} />
          </button>
        )}
      </span>
      {!recording && (
        <button type="button" className="linkbtn" title="恢复默认 Alt+Space" aria-label="恢复默认快捷键" onClick={onReset}>
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      )}
    </span>
  )
}
