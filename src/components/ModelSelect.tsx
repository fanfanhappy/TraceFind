import { useEffect, useState } from 'react'

interface Props {
  value: string
  options: string[]
  placeholder?: string
  onChange: (value: string) => void
}

/** 模型下拉框：常用模型直接选，选「自定义」时才出现输入框 */
export function ModelSelect({ value, options, placeholder, onChange }: Props) {
  const known = options.includes(value)
  const [custom, setCustom] = useState(!known && value.length > 0)

  // 外部把值改成预设里的模型时，收起自定义输入
  useEffect(() => {
    if (options.includes(value)) setCustom(false)
  }, [options, value])

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {custom ? (
        <input
          className="textfield"
          style={{ width: 320 }}
          value={value}
          placeholder={placeholder}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (!value.trim()) setCustom(false)
          }}
        />
      ) : (
        <select
          className="textfield"
          style={{ width: 320 }}
          value={known ? value : ''}
          onChange={(event) => {
            if (event.target.value === '__custom__') {
              setCustom(true)
              return
            }
            onChange(event.target.value)
          }}
        >
          {!known && <option value="">选择模型…</option>}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          <option value="__custom__">自定义…</option>
        </select>
      )}
      {custom && (
        <button type="button" className="linkbtn" onClick={() => setCustom(false)}>
          用列表选择
        </button>
      )}
    </div>
  )
}
