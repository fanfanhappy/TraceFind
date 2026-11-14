import { ArrowDown, ArrowUp, CornerDownLeft, Space } from 'lucide-react'
import type { IndexStatus } from '../lib/bridge'

interface Props {
  query: string
  total: number
  hotkey: string
  hotkeyActive: boolean
  /** 配置的快捷键被占用，已启用兜底组合 */
  hotkeyFallback?: boolean
  desktop: boolean
  index: IndexStatus
  status?: string
  /** 有新版本时显示提示 */
  updateVersion?: string | null
  onOpenSettings: () => void
  onOpenUpdate?: () => void
}

function compactCount(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function indexLabel(index: IndexStatus): string {
  switch (index.state) {
    case 'scanning':
      return `索引中 ${compactCount(index.scanned)}`
    case 'paused':
      return '索引已暂停'
    case 'ready':
      return `${compactCount(index.files)} 文件`
    case 'demo':
      return '演示数据'
    default:
      return index.files > 0 ? `${compactCount(index.files)} 文件` : '未索引'
  }
}

/** 02｜底部状态栏：44px，只放最短的键盘提示与索引状态 */
export function StatusBar({
  query,
  total,
  hotkey,
  hotkeyActive,
  hotkeyFallback,
  desktop,
  index,
  status,
  updateVersion,
  onOpenSettings,
  onOpenUpdate,
}: Props) {
  return (
    <footer className="statusbar">
      <div className="statusbar__hints">
        <kbd aria-hidden>
          <ArrowUp size={11} strokeWidth={2.2} />
        </kbd>
        <kbd aria-hidden>
          <ArrowDown size={11} strokeWidth={2.2} />
        </kbd>
        <span>选择</span>
        {total > 0 && (
          <>
            <kbd aria-hidden>
              <CornerDownLeft size={11} strokeWidth={2.2} />
            </kbd>
            <span>打开</span>
            <kbd aria-hidden>Ctrl+Space</kbd>
            <span>预览</span>
          </>
        )}
        {desktop && (
          <>
            <kbd style={{ marginLeft: 4 }}>Esc</kbd>
            <span>隐藏</span>
          </>
        )}
      </div>

      <div className="statusbar__trail">
        {status && <span role="status">{status}</span>}
        {updateVersion && (
          <button
            type="button"
            className="pill"
            data-kind="ok"
            title={`有新版本 ${updateVersion}，点击查看发布说明`}
            onClick={onOpenUpdate}
          >
            <span className="pill__dot" aria-hidden />
            新版本 {updateVersion}
          </button>
        )}
        {desktop && hotkeyFallback && (
          <button
            type="button"
            className="pill"
            data-kind="warn"
            title={`配置的快捷键被其他程序占用，已临时使用 ${hotkey}。点击到设置里固定。`}
            onClick={onOpenSettings}
          >
            <span className="pill__dot" aria-hidden />
            快捷键已降级
          </button>
        )}
        {desktop && !hotkeyActive && (
          <button
            type="button"
            className="pill"
            data-kind="warn"
            title={`全局快捷键 ${hotkey} 注册失败，可能已被其他程序占用。点击打开设置更换。`}
            onClick={onOpenSettings}
          >
            <span className="pill__dot" aria-hidden />
            快捷键冲突
          </button>
        )}
        <span
          className="pill"
          data-kind={index.state === 'ready' || index.state === 'demo' ? 'ok' : 'idle'}
          title={index.current || '索引状态'}
        >
          <span className="pill__dot" aria-hidden />
          {indexLabel(index)}
        </span>
        <span title={`全局快捷键 ${hotkey}`}>{hotkey}</span>

      </div>
    </footer>
  )
}