import { Pin, PinOff, Settings2, X } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { startDrag } from '../lib/bridge'

interface Props {
  pinned: boolean
  desktop: boolean
  onTogglePin: () => void
  onOpenSettings: () => void
  onClose: () => void
}

/** 02｜顶部品牌栏：48px，控制项保持低视觉权重 */
export function BrandBar({ pinned, desktop, onTogglePin, onOpenSettings, onClose }: Props) {
  return (
    <header
      className="brandbar"
      data-tauri-drag-region
      onDoubleClick={() => void startDrag()}
    >
      <div className="brandbar__brand" data-tauri-drag-region>
        <span className="brandbar__mark" data-tauri-drag-region aria-hidden>
          <BrandMark size={17} />
        </span>
        <span data-tauri-drag-region>TraceFind</span>
      </div>

      <div className="brandbar__controls">
        {desktop && (
          <button
            type="button"
            className="iconbtn interactive"
            title={pinned ? '取消置顶' : '窗口置顶'}
            aria-label={pinned ? '取消置顶' : '窗口置顶'}
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            {pinned ? <PinOff size={16} strokeWidth={1.75} /> : <Pin size={16} strokeWidth={1.75} />}
          </button>
        )}
        <button
          type="button"
          className="iconbtn interactive"
          title="设置  Ctrl+,"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          <Settings2 size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--danger interactive"
          title={desktop ? '隐藏窗口（保留托盘）' : '关闭预览'}
          aria-label="隐藏窗口"
          onClick={onClose}
        >
          <X size={17} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
