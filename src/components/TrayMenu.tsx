import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Download,
  Folder,
  Pause,
  Play,
  Power,
  Zap,
  Search,
  Settings2,
} from 'lucide-react'
import {
  checkUpdate,
  getIndexStatus,
  getRuntimeInfo,
  hideTrayMenu,
  loadSettings,
  openSettingsWindow,
  pauseIndex,
  quitApp,
  resumeIndex,
  toggleAutostart,
  type AppSettings,
  type IndexStatus,
  type UpdateStatus,
} from '../lib/bridge'
import { onTrayOpen, openDataDir, openUrl, showLauncher } from '../lib/bridge'
import { applyMaterial, useTheme } from '../lib/theme'

/** 托盘面板：跟随应用主题的自绘菜单，替代系统原生菜单 */
export function TrayMenu() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [index, setIndex] = useState<IndexStatus | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [hotkey, setHotkey] = useState('')

  const refresh = useCallback(() => {
    void loadSettings().then(setSettings)
    void getIndexStatus().then(setIndex)
    // 快捷键可能被占用而降级，面板要显示实际生效的那个
    void getRuntimeInfo().then((info) => setHotkey(info.hotkey || ''))
  }, [])

  useEffect(() => {
    refresh()
    applyMaterial('solid')
    let off: (() => void) | undefined
    void onTrayOpen(() => refresh()).then((fn) => {
      off = fn
    })
    return () => off?.()
  }, [refresh])

  useTheme(settings?.theme ?? 'dark', settings?.reducedMotion ?? false)

  // 每次弹出前刷新数据；点空白或 Esc 收起
  useEffect(() => {
    const hide = () => void hideTrayMenu()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('blur', hide)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const run = (action: () => void | Promise<unknown>) => {
    void Promise.resolve(action()).finally(() => void hideTrayMenu())
  }

  const files = index?.state === 'ready' ? index.files : index?.scanned ?? 0
  const scanning = index?.state === 'scanning'
  const paused = index?.state === 'paused'


  return (
    <div className="tray" role="menu" aria-label="TraceFind 托盘菜单">
      <div className="tray__head">
        <span className="tray__brand">TraceFind</span>
        <span className="tray__meta">
          {files > 0 ? `${files.toLocaleString('zh-CN')} 个文件` : '尚未建立索引'}
        </span>
      </div>

      <button type="button" className="tray__item" role="menuitem" onClick={() => run(() => showLauncher())}>
        <Search size={15} strokeWidth={1.8} />
        <span>打开搜索</span>
        <kbd>{hotkey}</kbd>
      </button>

      <button type="button" className="tray__item" role="menuitem" onClick={() => run(() => openSettingsWindow())}>
        <Settings2 size={15} strokeWidth={1.8} />
        <span>偏好设置</span>
      </button>

      <div className="tray__sep" role="separator" />

      <button
        type="button"
        className="tray__item"
        role="menuitem"
        disabled={!scanning && !paused}
        onClick={() => run(() => (paused ? resumeIndex() : pauseIndex()))}
      >
        {paused ? <Play size={15} strokeWidth={1.8} /> : <Pause size={15} strokeWidth={1.8} />}
        <span>{paused ? '继续索引' : '暂停索引'}</span>
        <span className="tray__hint">{scanning ? '进行中' : paused ? '已暂停' : '空闲'}</span>
      </button>

      <button
        type="button"
        className="tray__item"
        role="menuitem"
        disabled={checking}
        onClick={async () => {
          setChecking(true)
          try {
            const status = await checkUpdate(false)
            setUpdate(status)
            if (status.checked && status.available) void openUrl(status.url)
          } finally {
            setChecking(false)
          }
        }}
      >
        <Download size={15} strokeWidth={1.8} />
        <span>检查更新</span>
        <span className="tray__hint" title={update?.error ?? undefined}>
          {checking
            ? '检查中…'
            : update?.checked
              ? update.available
                ? `发现 ${update.latest}`
                : '已最新'
              : update?.error
                ? '检查失败'
                : '—'}
        </span>
      </button>

      <div className="tray__sep" role="separator" />

      <button
        type="button"
        className="tray__item"
        role="menuitem"
        onClick={async () => setSettings(await toggleAutostart())}
      >
        <Zap size={15} strokeWidth={1.8} />
        <span>开机启动</span>
        <span className="tray__hint">{settings?.autostart ? '已开启' : '已关闭'}</span>
      </button>

      <button type="button" className="tray__item" role="menuitem" onClick={() => run(() => openDataDir())}>
        <Folder size={15} strokeWidth={1.8} />
        <span>打开数据目录</span>
        <ArrowUpRight size={13} strokeWidth={1.8} className="tray__out" />
      </button>

      <div className="tray__sep" role="separator" />

      <button type="button" className="tray__item tray__item--danger" role="menuitem" onClick={() => run(() => quitApp())}>
        <Power size={15} strokeWidth={1.8} />
        <span>退出 TraceFind</span>
      </button>

      <div className="tray__foot">Esc 或点空白处关闭</div>
    </div>
  )
}
