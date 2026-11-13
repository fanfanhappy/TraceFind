import { useRef, type RefObject } from 'react'
import { Loader2, Search, X } from 'lucide-react'

interface Props {
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  hotkey: string
  busy?: boolean
  onChange: (value: string) => void
  onClear: () => void
}

function hotkeyParts(accel: string) {
  return accel.split('+').map(part => part.trim()).filter(Boolean)
}

/** 02｜搜索输入区：64px，主窗口视觉中心 */
export function SearchField({ inputRef, value, hotkey, busy, onChange, onClear }: Props) {
  const box = useRef<HTMLDivElement>(null)

  return (
    <div
      className="searchfield"
      ref={box}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) inputRef.current?.focus()
      }}
    >
      {busy ? (
        <Loader2 className="searchfield__icon" size={21} strokeWidth={1.75} style={{ animation: 'aura-spin 900ms linear infinite' }} />
      ) : (
        <Search className="searchfield__icon" size={21} strokeWidth={1.75} />
      )}

      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="搜索文件"
        aria-autocomplete="list"
        aria-controls="results"
        aria-expanded
        aria-activedescendant={undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="搜索文件名、路径或内容…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      <div className="searchfield__meta">
        {value ? (
          <button
            type="button"
            className="iconbtn interactive"
            title="清空搜索  Esc"
            aria-label="清空搜索"
            tabIndex={-1}
            onClick={onClear}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        ) : (
          <span style={{ display: 'inline-flex', gap: 3 }}>
            {hotkeyParts(hotkey).map((part) => (
              <kbd key={part}>{part}</kbd>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
