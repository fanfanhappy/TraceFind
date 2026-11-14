import { useCallback, useEffect, useState } from 'react'
import { ModelSelect } from '../components/ModelSelect'
import { describeProvider, modelOptions } from '../lib/models'
import {
  ArrowLeft,
  FolderSearch,
  Info,
  Keyboard,
  Palette,
  SlidersHorizontal,
  Sparkles,
  ArrowUpDown,
  TriangleAlert,
  X,
} from 'lucide-react'
import { HotkeyField, Segmented, Switch } from '../components/controls'
import {
  addRoot,
  applyHotkey,
  closeSettingsWindow,
  defaultSettings,
  getContentStatus,
  getIndexStatus,
  getSemanticStatus,
  getRuntimeInfo,
  isDesktop,
  loadSettings,
  onContentProgress,
  onIndexChanged,
  onIndexProgress,
  openSettingsWindow,
  pauseIndex,
  patchSettings,
  restartOnboarding,
  listModels,
  checkUpdate,
  installUpdate,
  onUpdateProgress,
  openUrl,
  type UpdateStatus,
  quitApp,
  rebuildContent,
  rebuildSemantic,
  removeRoot,
  resumeIndex,
  showLauncher,
  startDrag,
  cloudKeyStatus,
  onSemanticStatus,
  setSemantic,
  testCloudEmbedding,
  startIndex,
  type AppSettings,
  type ContentStatus,
  type IndexStatus,
  type SemanticStatus,
  type RuntimeInfo,
} from '../lib/bridge'
import { formatModified } from '../lib/files'
import { applyMaterial, useTheme } from '../lib/theme'

type SectionId = 'general' | 'hotkeys' | 'appearance' | 'indexing' | 'search' | 'ai' | 'about'

const SECTIONS: Array<{
  id: SectionId
  label: string
  icon: typeof Info
}> = [
  { id: 'general', label: '常规', icon: SlidersHorizontal },
  { id: 'hotkeys', label: '快捷键', icon: Keyboard },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'indexing', label: '索引与扫描', icon: FolderSearch },
  { id: 'search', label: '搜索与排序', icon: ArrowUpDown },
  { id: 'ai', label: 'AI 与模型', icon: Sparkles },
  { id: 'about', label: '关于', icon: Info },
]

export function Settings() {
  const [section, setSection] = useState<SectionId>('general')
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [info, setInfo] = useState<RuntimeInfo | null>(null)
  const [savingHotkey, setSavingHotkey] = useState(false)
  const [hotkeyError, setHotkeyError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [installing, setInstalling] = useState<{ phase: 'download' | 'install'; pct: number } | null>(null)
  const [installError, setInstallError] = useState('')
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState('')

  useEffect(
    () =>
      onUpdateProgress(({ downloaded, total }) => {
        const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0
        setInstalling((current) => (current ? { ...current, pct } : current))
      }),
    [],
  )

  const fetchModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsError('')
    try {
      const list = await listModels()
      setRemoteModels(list)
    } catch (err) {
      setModelsError(String(err))
    } finally {
      setLoadingModels(false)
    }
  }, [])

  const runCheck = useCallback(async () => {
    setChecking(true)
    setUpdateError('')
    try {
      const status = await checkUpdate(false)
      setUpdate(status)
      if (status.error) setUpdateError(status.error)
    } catch (err) {
      setUpdateError(String(err))
    } finally {
      setChecking(false)
    }
  }, [])
  const [indexing, setIndexing] = useState<IndexStatus>({
    state: 'idle',
    files: 0,
    scanned: 0,
    current: '',
    lastScan: 0,
    error: null,
  })
  const [content, setContent] = useState<ContentStatus>({
    done: 0,
    failed: 0,
    chars: 0,
    pending: 0,
    enabled: false,
  })
  const [semantic, setSemanticState] = useState<SemanticStatus>({
    enabled: false,
    state: 'disabled',
    provider: 'local',
    model: '',
    chunks: 0,
    vectors: 0,
    message: null,
  })
  const [cloudKeySaved, setCloudKeySaved] = useState(false)
  const [cloudKeyDraft, setCloudKeyDraft] = useState('')
  const [cloudTest, setCloudTest] = useState<{
    ok: boolean
    error?: string
    model?: string
    dim?: number
    ms?: number
  } | null>(null)
  const [rootDraft, setRootDraft] = useState('')
  const [excludeDraft, setExcludeDraft] = useState('')
  const [rootError, setRootError] = useState('')

  useTheme(settings.theme, settings.reducedMotion)

  useEffect(() => {
    let alive = true
    void (async () => {
      const loadedSettings = await loadSettings()
      const runtime = await getRuntimeInfo()
      const status = await getIndexStatus()
      if (!alive) return
      setSettings(loadedSettings)
      setInfo(runtime)
      applyMaterial(runtime.material)
      setIndexing(status)
      setContent(await getContentStatus())
      setSemanticState(await getSemanticStatus())
      setCloudKeySaved(await cloudKeyStatus())
      setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // 扫描进度实时刷新
  useEffect(() => onIndexProgress(setIndexing), [])

  // 正文抽取进度
  useEffect(() => onContentProgress(setContent), [])

  // 语义索引状态
  useEffect(() => onSemanticStatus(setSemanticState), [])

  // 监听器写入增量后刷新统计
  useEffect(
    () =>
      onIndexChanged(() => {
        void getIndexStatus().then(setIndexing)
      }),
    [],
  )

  async function rebuildDocs() {
    await rebuildContent()
    setContent(await getContentStatus())
  }

  async function scanNow() {
    await startIndex()
    setIndexing(await getIndexStatus())
  }

  async function addRootCommand() {
    const path = rootDraft.trim()
    if (!path) return
    setRootError('')
    try {
      const next = await addRoot(path)
      setSettings(next)
      setRootDraft('')
    } catch (error) {
      setRootError(String(error))
    }
  }

  async function removeRootCommand(path: string) {
    const next = await removeRoot(path)
    setSettings(next)
  }

  async function patch(value: Partial<AppSettings>) {
    const next = await patchSettings(value)
    setSettings(next)
  }

  async function commitHotkey(accel: string) {
    setSavingHotkey(true)
    setHotkeyError('')
    const result = await applyHotkey(accel)
    setSavingHotkey(false)
    if (!result.ok) {
      setHotkeyError(`无法注册 ${accel}：${result.conflict ?? '该组合已被占用'}。已保留原来的 ${settings.hotkey}。`)
      return
    }
    if (result.settings) setSettings(result.settings)
    setInfo((current) => (current ? { ...current, hotkey: accel, hotkeyActive: true } : current))
  }

  /** 返回搜索：设置窗先淡出，主窗口可交互后再隐藏自己；减少动效时直接切 */
  async function backToSearch() {
    const reduce =
      settings.reducedMotion ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.dataset.motion === 'reduced'
    const root = document.documentElement
    if (!reduce) {
      root.dataset.leaving = 'true'
      await new Promise((resolve) => window.setTimeout(resolve, 110))
    }
    await showLauncher()
    if (!reduce) {
      // 等主窗口淡入结束（160ms）再藏设置，避免两边同时动
      await new Promise((resolve) => window.setTimeout(resolve, 170))
    }
    await closeSettingsWindow()
    delete root.dataset.leaving
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 录制快捷键时 HotkeyField 会在捕获阶段拦下 Esc，这里不会触发
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        void backToSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="shell settings-app" data-material-ready={loaded}>
      <header className="brandbar" data-tauri-drag-region onDoubleClick={() => void startDrag()}>
        <div className="brandbar__brand" data-tauri-drag-region>
          <button
            type="button"
            className="iconbtn iconbtn--back"
            title="返回搜索窗口  Esc"
            aria-label="返回搜索窗口"
            onClick={() => void backToSearch()}
          >
            <ArrowLeft size={16} strokeWidth={1.9} />
          </button>
          <span data-tauri-drag-region>TraceFind</span>
        </div>
        <div className="brandbar__controls">
          <button
            type="button"
            className="iconbtn iconbtn--danger"
            title="关闭设置"
            aria-label="关闭设置"
            onClick={() => void closeSettingsWindow()}
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分类">
          <span className="settings-nav__label">设置</span>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="navitem"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={15} strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-main">
          {section === 'general' && (
            <>
              <h2>常规</h2>
              <p>控制窗口如何退到后台，以及应用是否随 Windows 启动。</p>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">关闭时隐藏到托盘</span>
                    <span className="setting-row__desc">开启时关闭主窗口会保留后台运行；关闭此选项后，关闭主窗口即退出。</span>
                  </span>
                  <Switch
                    label="关闭时隐藏到托盘"
                    checked={settings.closeToTray}
                    onChange={(value) => void patch({ closeToTray: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">开机自动启动</span>
                    <span className="setting-row__desc">通过系统登录项启动，登录后驻留托盘。{isDesktop ? '' : '（浏览器预览下不可用）'}</span>
                  </span>
                  <Switch
                    label="开机自动启动"
                    checked={settings.autostart}
                    disabled={!isDesktop}
                    onChange={(value) => void patch({ autostart: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">打开文件后保持窗口</span>
                    <span className="setting-row__desc">
                      开启时，从搜索结果打开文件后搜索窗不会自动隐藏，关掉文件即可继续操作；
                      关闭时窗口会在打开文件后隐藏，需要再用快捷键或托盘唤出。
                    </span>
                  </span>
                  <Switch
                    label="打开文件后保持窗口"
                    checked={settings.keepOpenAfterOpen}
                    onChange={(value) => void patch({ keepOpenAfterOpen: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">OCR 图片与扫描件</span>
                    <span className="setting-row__desc">
                      用 Windows 自带 OCR 识别图片与扫描版 PDF（无文字层的），识别结果进入正文索引；
                      不引入模型，只消耗 CPU。扫描件 PDF 每份最多识别 12 页。
                    </span>
                  </span>
                  <Switch
                    label="OCR 图片与扫描件"
                    checked={settings.ocrEnabled}
                    onChange={(value) => void patch({ ocrEnabled: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">列表显示条数</span>
                    <span className="setting-row__desc">主窗口一屏内展示的最大结果数。</span>
                  </span>
                  <Segmented
                    label="列表显示条数"
                    value={String(settings.resultLimit)}
                    options={[
                      { value: '5', label: '5' },
                      { value: '8', label: '8' },
                      { value: '12', label: '12' },
                    ]}
                    onChange={(value) => void patch({ resultLimit: Number(value) })}
                  />
                </div>
              </div>
            </>
          )}

          {section === 'hotkeys' && (
            <>
              <h2>快捷键</h2>
              <p>默认 Alt + Space 唤起搜索窗口；重复按下可隐藏。</p>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">唤起搜索</span>
                    <span className="setting-row__desc">全局生效。修改时先校验新组合，失败会自动回滚到原来的组合。</span>
                  </span>
                  <HotkeyField
                    accel={settings.hotkey}
                    saving={savingHotkey}
                    onCommit={(accel) => void commitHotkey(accel)}
                    onReset={() => void commitHotkey(defaultSettings.hotkey)}
                  />
                </div>
              </div>

              {hotkeyError && (
                <div className="note" style={{ marginBottom: 20 }}>
                  <TriangleAlert size={14} strokeWidth={1.75} />
                  <span>{hotkeyError}</span>
                </div>
              )}

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">键盘导航</span>
                    <span className="setting-row__desc">↑ ↓ 选择结果 · Enter 打开 · Space 预览 · Esc 隐藏窗口 · Ctrl + , 打开设置</span>
                  </span>
                </div>
              </div>

              {info?.hotkeyFallback ? (
                <div className="note">
                  <TriangleAlert size={14} strokeWidth={1.75} />
                  <span>
                    {info.hotkeyConfigured} 被其他程序占用，当前临时使用 <b>{info.hotkey}</b>。
                    点上面的「修改快捷键」录一个新组合即可固定下来。
                  </span>
                </div>
              ) : (
                <div className="note" data-kind="info">
                  <Info size={14} strokeWidth={1.75} />
                  <span>
                    当前注册状态：
                    {info?.hotkeyActive ? `已注册 ${info.hotkey}` : `${settings.hotkey}（此环境未注册）`}
                  </span>
                </div>
              )}
            </>
          )}

          {section === 'appearance' && (
            <>
              <h2>外观</h2>
              <p>深浅主题共享同一套组件规范；浅色不是简单反色。</p>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">主题</span>
                    <span className="setting-row__desc">跟随系统时自动响应 Windows 的深浅色切换。</span>
                  </span>
                  <Segmented
                    label="主题"
                    value={settings.theme}
                    options={[
                      { value: 'dark', label: '深色' },
                      { value: 'light', label: '浅色' },
                      { value: 'system', label: '跟随系统' },
                    ]}
                    onChange={(value) => void patch({ theme: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">减少动效</span>
                    <span className="setting-row__desc">关闭唤起/隐藏的位移与缩放，只保留极短的淡入淡出。</span>
                  </span>
                  <Switch
                    label="减少动效"
                    checked={settings.reducedMotion}
                    onChange={(value) => void patch({ reducedMotion: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">窗口材质</span>
                    <span className="setting-row__desc">
                      当前：{info?.material === 'mica' ? 'Mica' : info?.material === 'acrylic' ? 'Acrylic' : '不透明降级'}。
                      Windows 11 用 Mica/Acrylic，Windows 10 自动降级为不透明背景。
                    </span>
                  </span>
                  <span className="pill" data-kind={info?.material === 'solid' ? 'idle' : 'ok'}>
                    <span className="pill__dot" aria-hidden />
                    {info?.material === 'mica' ? 'Mica' : info?.material === 'acrylic' ? 'Acrylic' : 'Solid'}
                  </span>
                </div>
              </div>
            </>
          )}

          {section === 'indexing' && (
            <>
              <h2>索引与扫描</h2>
              <p>只建立文件名与路径索引，不读取文件内容；索引保存在本机应用数据目录。</p>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">
                      {indexing.state === 'scanning'
                        ? `正在索引 · 已扫描 ${indexing.scanned}`
                        : indexing.state === 'paused'
                          ? '索引已暂停'
                          : `已索引 ${indexing.files.toLocaleString('zh-CN')} 个条目`}
                    </span>
                    <span className="setting-row__desc">
                      {indexing.current || (indexing.lastScan ? `上次扫描：${formatModified(indexing.lastScan)}` : '尚未扫描')}
                      {' · '}
                      实时监听：{info?.watching ? '已开启' : '未启用'}
                    </span>
                  </span>
                  {indexing.state === 'scanning' || indexing.state === 'paused' ? (
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => {
                        if (indexing.state === 'paused') {
                          void resumeIndex()
                        } else {
                          void pauseIndex()
                        }
                      }}
                    >
                      {indexing.state === 'paused' ? '继续' : '暂停'}
                    </button>
                  ) : (
                    <button type="button" className="linkbtn linkbtn--primary" onClick={() => void scanNow()}>
                      重新扫描
                    </button>
                  )}
                </div>

                {(indexing.state === 'scanning' || indexing.state === 'paused') && (
                  <div className="progress" role="progressbar" aria-label="索引进度">
                    <div
                      className="progress__bar"
                      style={{ width: `${Math.min(100, (indexing.scanned % 500) / 5)}%`, opacity: 0.7 }}
                    />
                  </div>
                )}

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">扫描范围</span>
                    <span className="setting-row__desc">这些目录下的文件名与路径会被索引；移除后需要重新扫描才会清理。</span>
                  </span>
                </div>
                <div className="pathlist">
                  {settings.roots.length === 0 && <span className="setting-row__desc">尚未设置扫描目录</span>}
                  {settings.roots.map((root) => (
                    <div className="pathrow" key={root}>
                      <FolderSearch size={13} strokeWidth={1.75} />
                      <span title={root}>{root}</span>
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => void removeRootCommand(root)}
                        title="从扫描范围移除"
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <div className="pathrow" style={{ borderStyle: 'dashed' }}>
                    <input
                      className="textfield"
                      placeholder="粘贴一个目录路径，例如 D:\工作"
                      value={rootDraft}
                      spellCheck={false}
                      onChange={(event) => setRootDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void addRootCommand()
                      }}
                    />
                    <button type="button" className="linkbtn" onClick={() => void addRootCommand()}>
                      添加
                    </button>
                  </div>
                  {rootError && <span className="setting-row__desc" style={{ color: 'var(--danger)' }}>{rootError}</span>}
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">排除目录</span>
                    <span className="setting-row__desc">这些目录（含子目录）不会被扫描，适合放缓存、构建产物。</span>
                  </span>
                </div>
                <div className="pathlist">
                  {settings.excludedPaths.length === 0 && (
                    <span className="setting-row__desc">没有额外排除项</span>
                  )}
                  {settings.excludedPaths.map((path) => (
                    <div className="pathrow" key={path}>
                      <TriangleAlert size={13} strokeWidth={1.75} />
                      <span title={path}>{path}</span>
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => void patch({ excludedPaths: settings.excludedPaths.filter((item) => item !== path) })}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <div className="pathrow" style={{ borderStyle: 'dashed' }}>
                    <input
                      className="textfield"
                      placeholder="粘贴要排除的目录路径"
                      value={excludeDraft}
                      spellCheck={false}
                      onChange={(event) => setExcludeDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && excludeDraft.trim()) {
                          void patch({
                            excludedPaths: [...settings.excludedPaths, excludeDraft.trim()],
                          })
                          setExcludeDraft('')
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="setting-group" style={{ marginTop: 20 }}>
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">正文索引</span>
                    <span className="setting-row__desc">
                      已提取 {content.done.toLocaleString('zh-CN')} 篇 · 待处理 {content.pending.toLocaleString('zh-CN')} · 失败{' '}
                      {content.failed.toLocaleString('zh-CN')}
                      {content.chars > 0 ? ` · 共 ${(content.chars / 10000).toFixed(1)} 万字` : ''}
                    </span>
                  </span>
                  <button type="button" className="linkbtn" onClick={() => void rebuildDocs()}>
                    重建
                  </button>
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">启用正文索引</span>
                    <span className="setting-row__desc">
                      关闭后停止抽取正文，并且搜索结果只包含文件名与路径；重新开启会继续补齐未处理的文件。
                    </span>
                  </span>
                  <Switch
                    label="启用正文索引"
                    checked={settings.contentIndex}
                    onChange={(value) => void patch({ contentIndex: value })}
                  />
                </div>

                <div className="setting-row">
                  <span className="setting-row__desc">
                    支持 TXT / Markdown / 代码 / CSV、DOCX、PPTX、XLSX、可选中文本的 PDF。
                    图片与扫描版 PDF 可在「常规」里开启 OCR；超过 16 MB 的文件跳过。
                  </span>
                </div>
              </div>
            </>
          )}

          {section === 'search' && (
            <>
              <h2>搜索与排序</h2>
              <p>控制结果如何排序，以及默认只看哪一类文件；搜索窗里的筛选条会跟着这里同步。</p>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">排序方式</span>
                    <span className="setting-row__desc">
                      相关度=按匹配质量打分；其余按对应字段排序，仍只返回命中的结果。
                    </span>
                  </span>
                  <div className="segmented">
                    <button
                      type="button"
                      aria-pressed={settings.sortMode === 'relevance'}
                      onClick={() => void patch({ sortMode: 'relevance' })}
                    >
                      相关度
                    </button>
                    <button
                      type="button"
                      aria-pressed={settings.sortMode === 'recent'}
                      onClick={() => void patch({ sortMode: 'recent' })}
                    >
                      修改时间
                    </button>
                    <button
                      type="button"
                      aria-pressed={settings.sortMode === 'name'}
                      onClick={() => void patch({ sortMode: 'name' })}
                    >
                      名称
                    </button>
                    <button
                      type="button"
                      aria-pressed={settings.sortMode === 'size'}
                      onClick={() => void patch({ sortMode: 'size' })}
                    >
                      大小
                    </button>
                  </div>
                </div>

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">默认类型筛选</span>
                    <span className="setting-row__desc">
                      只在结果很多、想先收窄范围时使用；切回「全部」即可恢复。
                    </span>
                  </span>
                  <div className="segmented">
                    {(
                      [
                        ['all', '全部'],
                        ['doc', '文档'],
                        ['image', '图片'],
                        ['code', '代码'],
                        ['folder', '文件夹'],
                        ['other', '其他'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={settings.typeFilter === id}
                        onClick={() => void patch({ typeFilter: id })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="note" data-kind="info">
                <Info size={14} strokeWidth={1.75} />
                <span>
                  拼音、首字母与容错匹配始终开启；排序只影响结果的先后，不影响能否命中。
                </span>
              </div>
            </>
          )}

          {section === 'ai' && (
            <>
              <h2>AI 与模型</h2>
              <p>语义检索可以用本地模型（完全离线），也可以接云端接口；切换提供方会重建向量。</p>
              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">语义提供方</span>
                    <span className="setting-row__desc">
                      本地模型完全离线；云端接口配置更省心，但查询文本会发送到所填地址。
                    </span>
                  </span>
                  <div className="segmented">
                    <button
                      type="button"
                      aria-pressed={settings.semanticProvider === 'local'}
                      onClick={() => void patch({ semanticProvider: 'local' })}
                    >
                      本地模型
                    </button>
                    <button
                      type="button"
                      aria-pressed={settings.semanticProvider === 'cloud'}
                      onClick={() => void patch({ semanticProvider: 'cloud' })}
                    >
                      云端接口
                    </button>
                  </div>
                </div>

                {settings.semanticProvider === 'cloud' && (
                  <>
                    <div className="setting-row">
                      <span className="setting-row__text">
                        <span className="setting-row__title">接口地址</span>
                        <span className="setting-row__desc">OpenAI 兼容的 /embeddings 端点</span>
                      </span>
                      <input
                        className="textfield"
                        style={{ width: 320 }}
                        value={settings.cloudBaseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => void patch({ cloudBaseUrl: event.target.value })}
                      />
                    </div>
                    <div className="setting-row">
                      <span className="setting-row__text">
                        <span className="setting-row__title">嵌入模型</span>
                        <span className="setting-row__desc">
                          {describeProvider(settings.cloudBaseUrl)}
                          {modelsError ? ` · ${modelsError}` : ' · 常用模型可直接选，也可以从接口拉取'}
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <ModelSelect
                          value={settings.cloudModel}
                          options={modelOptions(settings.cloudBaseUrl, 'embedding', remoteModels, settings.cloudModel)}
                          placeholder="text-embedding-3-small"
                          onChange={(value) => void patch({ cloudModel: value })}
                        />
                        <button
                          type="button"
                          className="linkbtn"
                          disabled={loadingModels}
                          onClick={() => void fetchModels()}
                        >
                          {loadingModels ? '获取中…' : '从接口获取'}
                        </button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <span className="setting-row__text">
                        <span className="setting-row__title">API Key</span>
                        <span className="setting-row__desc">
                          {cloudKeySaved
                            ? '已保存（DPAPI 加密，仅当前用户可解）'
                            : '未保存；填写后按 Windows DPAPI 加密落盘'}
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          className="textfield"
                          style={{ width: 240 }}
                          type="password"
                          value={cloudKeyDraft}
                          placeholder={cloudKeySaved ? '••••••••（已保存）' : 'sk-...'}
                          onChange={(event) => setCloudKeyDraft(event.target.value)}
                        />
                        <button
                          type="button"
                          className="linkbtn"
                          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                          onClick={() => {
                            void patch({ cloudApiKey: cloudKeyDraft }).then(() => {
                              setCloudKeyDraft('')
                              void cloudKeyStatus().then(setCloudKeySaved)
                            })
                          }}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <span className="setting-row__text">
                        <span className="setting-row__title">连接测试</span>
                        <span className="setting-row__desc">
                          {cloudTest
                            ? cloudTest.ok
                              ? `可用：${cloudTest.model} · ${cloudTest.dim} 维 · ${cloudTest.ms}ms`
                              : `失败：${cloudTest.error}`
                            : '用当前配置试算一次，确认地址、模型与 Key 都能用'}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="linkbtn"
                        style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                        onClick={() => {
                          void testCloudEmbedding({
                            baseUrl: settings.cloudBaseUrl,
                            model: settings.cloudModel,
                            apiKey: cloudKeyDraft || undefined,
                          })
                            .then((result) => setCloudTest(result))
                            .catch((error) => setCloudTest({ ok: false, error: String(error) }))
                        }}
                      >
                        测试连接
                      </button>
                    </div>
                  </>
                )}

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">语义检索</span>
                    <span className="setting-row__desc">
                      模型 {semantic.model || 'bge-small-zh-v1.5'} ·
                      {' '}
                      {semantic.state === 'ready'
                        ? `已就绪（${semantic.chunks.toLocaleString('zh-CN')} 块 / ${semantic.vectors.toLocaleString('zh-CN')} 向量）`
                        : semantic.state === 'downloading'
                          ? '正在准备模型…'
                          : semantic.state === 'error'
                            ? `出错：${semantic.message ?? '未知原因'}`
                            : semantic.enabled
                              ? '等待建立索引'
                              : '未启用'}
                    </span>
                  </span>
                  <Switch
                    label="语义检索"
                    checked={settings.semanticEnabled}
                    disabled={settings.semanticProvider === 'cloud' && !settings.cloudConsent}
                    onChange={(value) => {
                      void setSemantic(value)
                        .then(setSettings)
                        .catch((error) => setCloudTest({ ok: false, error: String(error) }))
                    }}
                  />
                </div>
                <div className="setting-row">
                  <span className="setting-row__desc">
                    本地模型首次启用会下载约 25–100 MB，存放在应用数据目录；
                    不启用时不下载、不占内存。索引完成后，搜索会为文件名、正文、语义三路结果做融合排序。
                  </span>
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() =>
                      void rebuildSemantic().then(() => getSemanticStatus().then(setSemanticState))
                    }
                  >
                    重建语义索引
                  </button>
                </div>
              </div>

              {settings.semanticProvider === 'cloud' && (
                <div className="note" data-kind="warn">
                  <TriangleAlert size={14} strokeWidth={1.75} />
                  <span>
                    <b>云端模式会发送两类内容：</b>
                    ① 待索引文档的正文片段（每 400 字一块，单篇最多 40 块）；
                    ② 每次搜索的查询文本。
                    目标地址：<code>{settings.cloudBaseUrl || '（未填写）'}</code>，
                    模型：<code>{settings.cloudModel || '（未填写）'}</code>。
                    参与云端索引的目录：
                    {settings.roots.length > 0
                      ? settings.roots.map((root) => (
                          <code key={root} style={{ marginLeft: 4 }}>
                            {root}
                          </code>
                        ))
                      : '（未添加目录）'}
                    。不希望发送请切回「本地模型」。
                  </span>
                </div>
              )}

              {settings.semanticProvider === 'cloud' && (
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">确认数据边界</span>
                    <span className="setting-row__desc">
                      勾选后才能开启云端语义索引；切换回本地模型不受限制。
                    </span>
                  </span>
                  <Switch
                    label="我已知晓并同意把文档片段发送到上述地址"
                    checked={settings.cloudConsent}
                    onChange={(value) => void patch({ cloudConsent: value })}
                  />
                </div>
              )}

              <div className="setting-group" style={{ marginTop: 20 }}>
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">AI 文件助手</span>
                    <span className="setting-row__desc">
                      用本地检索挑出最相关的正文片段，再让云端模型基于这些片段回答（RAG），
                      会复用上面的接口地址与 API Key。搜索框里按 Ctrl+Enter 提问。
                    </span>
                  </span>
                  <Switch
                    label="AI 文件助手"
                    checked={settings.assistantEnabled}
                    onChange={(value) => void patch({ assistantEnabled: value })}
                  />
                </div>
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">问答模型</span>
                    <span className="setting-row__desc">
                      {describeProvider(settings.cloudBaseUrl)} · 需与接口地址兼容
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <ModelSelect
                      value={settings.assistantModel}
                      options={modelOptions(settings.cloudBaseUrl, 'chat', remoteModels, settings.assistantModel)}
                      placeholder="gpt-4o-mini"
                      onChange={(value) => void patch({ assistantModel: value })}
                    />
                    <button
                      type="button"
                      className="linkbtn"
                      disabled={loadingModels}
                      onClick={() => void fetchModels()}
                    >
                      {loadingModels ? '获取中…' : '从接口获取'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="note" data-kind="info">
                <Info size={14} strokeWidth={1.75} />
                <span>
                  {settings.semanticProvider === 'cloud'
                    ? '云端模式下，索引与搜索都会把文本发送到所填地址，请确认该服务的数据使用条款。'
                    : '本地模式下所有向量都在本机计算，文档与查询都不出网。'}
                </span>
              </div>
            </>
          )}

          {section === 'about' && (
            <>
              <h2>关于</h2>
              <p>TraceFind · 本地文件搜索 · 全文检索 · AI 语义搜索</p>

              <div className="setting-group">
                <div className="setting-row">
                  <dl className="kv" style={{ width: '100%' }}>
                    <dt>版本</dt>
                    <dd>v{info?.version ?? '0.1.0'}</dd>
                    <dt>运行环境</dt>
                    <dd>{info?.platform ?? '—'}</dd>
                    <dt>窗口材质</dt>
                    <dd>{info?.material ?? 'solid'}</dd>
                    <dt>全局快捷键</dt>
                    <dd>{info?.hotkey ?? settings.hotkey}</dd>
                    <dt>配置目录</dt>
                    <dd title={info?.dataDir}>{info?.dataDir ?? '—'}</dd>
                  </dl>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">检查更新</span>
                    <span className="setting-row__desc">
                      {checking
                        ? '正在检查…'
                        : updateError
                          ? updateError
                          : update?.checked && update.available
                            ? `发现新版本 ${update.latest}（当前 ${update.current}）`
                            : update?.checked
                              ? '已是最新版本'
                              : `当前 v${info?.version ?? '0.1.0'}，只读取 GitHub 的公开版本信息`}
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {update?.checked && update.available && installing && (
                      <span className="setting-row__desc">
                        {installing.phase === 'install'
                          ? '正在替换程序，即将重启…'
                          : `正在下载 ${installing.pct}%`}
                      </span>
                    )}
                    {update?.checked && update.available && !installing && (
                      <>
                        <button
                          type="button"
                          className="linkbtn linkbtn--primary"
                          title="下载并校验 sha256，然后替换当前程序并重启"
                          disabled={update.sha256.length !== 64}
                          onClick={() => {
                            setInstallError('')
                            setInstalling({ phase: 'download', pct: 0 })
                            void installUpdate(update.url, update.sha256)
                              .then(() => setInstalling({ phase: 'install', pct: 100 }))
                              .catch((err) => {
                                setInstalling(null)
                                setInstallError(String(err))
                              })
                          }}
                        >
                          下载并安装
                        </button>
                        <button type="button" className="linkbtn" onClick={() => void openUrl(update.url)}>
                          查看下载
                        </button>
                        <button
                          type="button"
                          className="linkbtn"
                          title="不再提示这个版本"
                          onClick={() => {
                            void patchSettings({ skippedVersion: update.latest }).then(setSettings)
                          }}
                        >
                          跳过此版本
                        </button>
                      </>
                    )}
                    <button type="button" className="linkbtn" disabled={checking} onClick={() => void runCheck()}>
                      {checking ? '检查中…' : '检查'}
                    </button>
                  </div>
                </div>
                {installError && (
                  <div className="setting-row">
                    <span className="setting-row__desc" style={{ color: 'var(--danger)' }}>
                      安装失败：{installError}；可以改用「查看下载」手动更新。
                    </span>
                  </div>
                )}

                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">启动时自动检查</span>
                    <span className="setting-row__desc">每天最多一次；关闭后只在手动点击时检查。</span>
                  </span>
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={settings.checkUpdates}
                    onClick={() => {
                      void patchSettings({ checkUpdates: !settings.checkUpdates }).then(setSettings)
                    }}
                  >
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">重新观看新手引导</span>
                    <span className="setting-row__desc">不改变已有目录与索引，只看一遍三步引导。</span>
                  </span>
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => {
                      // 命令会关掉设置窗口并抬起主窗口里的引导
                      void restartOnboarding()
                    }}
                  >
                    重新播放
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">退出 TraceFind</span>
                    <span className="setting-row__desc">结束进程并释放托盘图标；下次启动需重新唤起。</span>
                  </span>
                  <button type="button" className="linkbtn" onClick={() => void quitApp()}>
                    退出
                  </button>
                </div>
                <div className="setting-row">
                  <span className="setting-row__text">
                    <span className="setting-row__title">返回搜索</span>
                    <span className="setting-row__desc">关闭设置并唤起搜索窗口；也可以按 Esc 或左上角的返回箭头。</span>
                  </span>
                  <button type="button" className="linkbtn linkbtn--primary" onClick={() => void backToSearch()}>
                    回到搜索
                  </button>
                </div>
              </div>

            </>
          )}
        </div>
      </div>
    </div>
  )
}
