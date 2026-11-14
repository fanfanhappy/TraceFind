import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AnimationEvent as ReactAnimationEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { BrandBar } from '../components/BrandBar'
import { SearchField } from '../components/SearchField'
import { AskPanel } from '../components/AskPanel'
import { ResultsList } from '../components/Results'
import { EmptyIndex, NoResults, QuickActions, type NoResultReason } from '../components/EmptyState'
import { StatusBar } from '../components/StatusBar'
import { PreviewDrawer } from '../components/PreviewDrawer'
import { Onboarding } from '../components/Onboarding'
import {
  checkUpdate,
  openUrl,
  defaultSettings,
  frontendReady,
  getIndexStatus,
  getRuntimeInfo,
  hideLauncher,
  isDesktop,
  loadSettings,
  notifyAnimationFinished,
  onContentProgress,
  onHotkeyConflict,
  onHotkeyFallback,
  onSemanticHits,
  onHotkeyRegistered,
  onIndexChanged,
  onIndexProgress,
  onLauncherFocus,
  onLauncherHide,
  onLauncherShow,
  onSettingsChanged,
  openSettingsWindow,
  patchSettings,
  recentFiles,
  revealFile,
  searchFiles,
  askFiles,
  openFileHold,
  setAlwaysOnTop,
  setWindowDark,
  startIndex,
  type AppSettings,
  type IndexStatus,
  type LauncherPhase,
} from '../lib/bridge'
import type { SearchHit } from '../lib/files'
import { applyMaterial, resolveDark, useTheme } from '../lib/theme'

const emptyIndex: IndexStatus = {
  state: 'idle',
  files: 0,
  scanned: 0,
  current: '',
  lastScan: 0,
  error: null,
}

const TYPE_FILTERS: Array<{ id: AppSettings['typeFilter']; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'doc', label: '文档' },
  { id: 'image', label: '图片' },
  { id: 'code', label: '代码' },
  { id: 'folder', label: '文件夹' },
  { id: 'other', label: '其他' },
]

export function Launcher() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [scope, setScope] = useState<string | null>(null)
  const [index, setIndex] = useState<IndexStatus>(emptyIndex)
  const [searching, setSearching] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('')
  const [hotkeyActive, setHotkeyActive] = useState(true)
  const [effectiveHotkey, setEffectiveHotkey] = useState('Alt+Space')
  const [hotkeyFallback, setHotkeyFallback] = useState(false)
  const [ask, setAsk] = useState<{ question: string; answer: Awaited<ReturnType<typeof askFiles>> | null; loading: boolean; error: string | null } | null>(null)
  const [newHits, setNewHits] = useState<{ count: number; first: string } | null>(null)
  const [update, setUpdate] = useState<{ latest: string; url: string } | null>(null)
  // 这批结果对应的「查询 + 范围」，用来判断列表是否已经过期
  const [resultsKey, setResultsKey] = useState('')
  const [revision, setRevision] = useState(0)
  const [phase, setPhase] = useState<LauncherPhase>(isDesktop ? 'hidden' : 'visible')

  const inputRef = useRef<HTMLInputElement>(null)
  // 记录当前选中项的路径：索引后台刷新后按路径恢复，避免按 Enter 打开错文件
  const activePathRef = useRef<string | null>(null)
  const searchRequest = useRef(0)
  const pendingSemantic = useRef<SearchHit[] | null>(null)
  const hitsRef = useRef<SearchHit[]>([])
  const scrollRef = useRef(0)
  const phaseRef = useRef<LauncherPhase>(phase)
  phaseRef.current = phase

  useTheme(settings.theme, settings.reducedMotion)

  // 预览跟随选中项：打开后按 ↑↓ 会实时切换，和 Finder/Everything 的手感一致
  const previewFile = previewOpen ? (hits[activeIndex] ?? null) : null

  useEffect(() => {
    activePathRef.current = hits[activeIndex]?.path ?? null
  }, [hits, activeIndex])

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  /* ---------------------------------------------------- 启动：设置、索引、环境 */

  useEffect(() => {
    let alive = true
    void (async () => {
      const loaded = await loadSettings()
      if (!alive) return
      setSettings(loaded)

      const info = await getRuntimeInfo()
      if (!alive) return
      applyMaterial(info.material)
      setHotkeyActive(info.hotkeyActive)
      setEffectiveHotkey(info.hotkey || loaded.hotkey)
      setHotkeyFallback(Boolean(info.hotkeyFallback))
      if (info.hotkeyFallback && info.hotkeyConfigured) {
        setStatus(`${info.hotkeyConfigured} 被其他程序占用，已临时使用 ${info.hotkey}；可在设置里固定`)
      }
      if (isDesktop) await setWindowDark(resolveDark(loaded.theme))

      const status = await getIndexStatus()
      if (!alive) return
      setIndex(status)
      setReady(true)

      if (isDesktop) await frontendReady()
    })()
    return () => {
      alive = false
    }
  }, [])

  /* 浏览器预览没有事件推送，挂载后主动聚焦一次 */
  useEffect(() => {
    if (!isDesktop) focusInput()
  }, [focusInput])

  /* ---------------------------------------------------- 索引进度 */

  useEffect(() => {
    const off = onIndexProgress((next) => {
      setIndex(next)
    })
    return off
  }, [])

  // 正文入库后刷新当前查询：不用重新输入就能看到正文命中
  useEffect(() => {
    let last = 0
    return onContentProgress(() => {
      const now = Date.now()
      if (now - last < 800) return
      last = now
      setRevision((value) => value + 1)
    })
  }, [])

  // 文件系统变化（新建/改名/删除）写入索引后，静默刷新当前列表
  useEffect(
    () =>
      onIndexChanged((payload) => {
        setIndex((current) => ({ ...current, files: payload.files }))
        setRevision((value) => value + 1)
      }),
    [],
  )

  /* ---------------------------------------------------- 查询（防抖 + 竞态保护） */

  const onboardingOpen = isDesktop && ready && !settings.onboardingComplete

  useEffect(() => {
    if (!ready || onboardingOpen) return
    let alive = true
    const trimmed = query.trim()
    const requestId = ++searchRequest.current
    pendingSemantic.current = []
    setNewHits(null)

    if (trimmed) setSearching(true)
    const delay = trimmed ? 45 : 0

    const timer = window.setTimeout(() => {
      void (async () => {
        const list = trimmed
          ? await searchFiles(trimmed, scope, Math.max(20, settings.resultLimit * 3), requestId)
          : await recentFiles(scope, settings.resultLimit)
        if (!alive) return
        const limited = list.slice(0, Math.max(3, settings.resultLimit))
        const previous = activePathRef.current
        hitsRef.current = limited
        setHits(limited)
        setResultsKey(trimmed + '|' + (scope ?? ''))
        const pending = pendingSemantic.current
        pendingSemantic.current = null
        if (pending?.length) mergeSemanticHits(pending)
        if (previous) {
          const kept = limited.findIndex((hit) => hit.path === previous)
          setActiveIndex(kept >= 0 ? kept : limited.length > 0 ? 0 : -1)
        } else {
          setActiveIndex(limited.length > 0 ? 0 : -1)
        }
        if (!limited.length && hitsRef.current.length) setActiveIndex(0)
        setSearching(false)
      })()
    }, delay)

    return () => {
      alive = false
      searchRequest.current++
      window.clearTimeout(timer)
    }
  }, [query, scope, settings.resultLimit, settings.typeFilter, settings.sortMode, settings.semanticEnabled, settings.semanticProvider, settings.cloudBaseUrl, settings.cloudModel, ready, onboardingOpen, index.lastScan, revision])

  /* ---------------------------------------------------- 生命周期：事件驱动 */

  useEffect(() => {
    const offShow = onLauncherShow(() => {
      setStatus('')
      setPreviewOpen(false)
      // 接着上次：按 path 恢复选中项，并回到原来的滚动位置
      const previous = activePathRef.current
      const list = hitsRef.current
      const index = previous ? list.findIndex((hit) => hit.path === previous) : -1
      setActiveIndex(index >= 0 ? index : 0)
      setPhase('showing')
      focusInput()
      window.requestAnimationFrame(() => {
        const el = document.getElementById('results')
        if (el) el.scrollTop = scrollRef.current
      })
      void getIndexStatus().then(setIndex)
    })
    const offHide = onLauncherHide(() => {
      const el = document.getElementById('results')
      if (el) scrollRef.current = el.scrollTop
      setNewHits(null)
      setPhase((current) => (current === 'hidden' ? 'hidden' : 'hiding'))
    })
    const offFocus = onLauncherFocus(() => {
      // 退场动画播到一半又被唤起：Rust 已经把窗口留在可见态，UI 相位要跟上
      setPhase((current) => (current === 'hiding' ? 'visible' : current))
      focusInput()
    })
    return () => {
      offShow()
      offHide()
      offFocus()
    }
  }, [focusInput])

  useEffect(() => onSettingsChanged((next) => setSettings(next)), [])

  useEffect(() => {
    hitsRef.current = hits
  }, [hits])

  // 启动时检查更新：默认 24 小时一次，可在设置里关掉
  useEffect(() => {
    if (!isDesktop || !ready || onboardingOpen || !settings.checkUpdates) return
    const now = Math.floor(Date.now() / 1000)
    if (now - settings.lastUpdateCheck < 86400) return
    let alive = true
    void checkUpdate(true)
      .then((status) => {
        if (!alive || !status.checked || !status.available) return
        if (status.latest === settings.skippedVersion) return
        setUpdate({ latest: status.latest, url: status.url })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [ready, onboardingOpen, settings.checkUpdates, settings.lastUpdateCheck, settings.skippedVersion])

  function mergeSemanticHits(extra: SearchHit[]) {
    const current = hitsRef.current
    const existing = new Set(current.map((hit) => hit.path))
    const added = extra.filter((hit) => !existing.has(hit.path))
    if (!added.length) return
    const merged = [...current, ...added]
    hitsRef.current = merged
    setHits(merged)
    setNewHits({ count: added.length, first: added[0].path })

    // 语义结果是追加的：按 path 把选中项留在原处，列表不跳
    const previous = activePathRef.current
    if (previous) {
      const index = merged.findIndex((hit) => hit.path === previous)
      if (index >= 0) setActiveIndex(index)
    }
  }

  useEffect(
    () => onSemanticHits(({ requestId, hits: extra }) => {
      if (requestId !== searchRequest.current) return
      if (pendingSemantic.current) pendingSemantic.current = extra
      else {
        const wasEmpty = hitsRef.current.length === 0
        mergeSemanticHits(extra)
        if (wasEmpty && extra.length) setActiveIndex(0)
      }
    }),
    [],
  )

  useEffect(
    () =>
      onHotkeyFallback(({ configured, active }) => {
        setEffectiveHotkey(active)
        setHotkeyActive(true)
        setHotkeyFallback(true)
        setStatus(`${configured} 被其他程序占用，已临时使用 ${active}；可在设置里固定`)
      }),
    [],
  )

  useEffect(
    () =>
      onHotkeyConflict((accel) => {
        setHotkeyActive(false)
        setStatus(`快捷键 ${accel} 已被其他程序占用，请到设置中更换`)
      }),
    [],
  )

  useEffect(
    () =>
      onHotkeyRegistered(() => {
        setHotkeyActive(true)
        setStatus('')
      }),
    [],
  )

  /* 动画兜底：animationend 未触发时也要收敛状态 */
  useEffect(() => {
    if (phase !== 'showing' && phase !== 'hiding') return
    const timer = window.setTimeout(() => {
      if (phaseRef.current !== phase) return
      if (phase === 'showing') {
        setPhase('visible')
        void notifyAnimationFinished('show')
      } else {
        setPhase('hidden')
        void notifyAnimationFinished('hide')
      }
    }, phase === 'showing' ? 320 : 260)
    return () => window.clearTimeout(timer)
  }, [phase])

  function onAnimationEnd(event: ReactAnimationEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return
    if (phase === 'showing') {
      setPhase('visible')
      void notifyAnimationFinished('show')
    } else if (phase === 'hiding') {
      setPhase('hidden')
      void notifyAnimationFinished('hide')
    }
  }

  /* ---------------------------------------------------- 动作 */

  function updateQuery(value: string) {
    setQuery(value)
    setStatus('')
  }

  const runAsk = (question: string) => {
    setAsk({ question, answer: null, loading: true, error: null })
    void askFiles(question, scope)
      .then((result) => setAsk({ question, answer: result, loading: false, error: null }))
      .catch((error) =>
        setAsk({ question, answer: null, loading: false, error: String(error) }),
      )
  }

  function openAt(index: number) {
    if (isStale()) {
      setStatus('结果还在更新，稍等一下再打开')
      return
    }
    const hit = hits[index]
    if (!hit) return
    setActiveIndex(index)
    // 后端在同一次调用里先设「保持可见」再打开，避免两条 IPC 抢时序；
    // 打开结果也由后端返回，界面不再无条件显示「已打开」。
    void openFileHold(hit.path, settings.keepOpenAfterOpen).then((result) => {
      setStatus(result.ok ? `已打开：${hit.name}` : `打开失败：${result.error ?? '未知原因'}`)
    })
  }

  function revealAt(index: number) {
    if (isStale()) {
      setStatus('结果还在更新，稍等一下再定位')
      return
    }
    const hit = hits[index]
    if (!hit) return
    setStatus(`已在资源管理器中定位：${hit.name}`)
    void revealFile(hit.path)
  }

  function focusResults() {
    document.getElementById('results')?.focus({ preventScroll: true })
  }

  function move(delta: number) {
    if (hits.length === 0) return
    focusResults()
    setActiveIndex((current) => {
      const from = current < 0 ? (delta > 0 ? -1 : 0) : current
      return (from + delta + hits.length) % hits.length
    })
  }

  function hide() {
    if (isDesktop) {
      void hideLauncher()
      return
    }
    updateQuery('')
    setPreviewOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (onboardingOpen) return
    // 输入法组合期间不接管按键（中文输入必须可用）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    // 焦点在结果列表时，继续输入应该回到搜索框（否则方向键之后就没法改词）
    const focusedResults = (event.target as HTMLElement).id === 'results'
    if (focusedResults && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const printable = event.key.length === 1 && event.key !== ' '
      const editing = event.key === 'Backspace' || event.key === 'Delete'
      if (printable || editing) {
        focusInput()
        return
      }
    }

    // 焦点在按钮上时把 Enter / Space 交还给浏览器，否则键盘用户按不动置顶/设置/关闭
    const target = event.target as HTMLElement
    if ((event.key === 'Enter' || event.key === ' ') && target.closest?.('button')) {
      return
    }

    if (event.ctrlKey && event.key === ',') {
      event.preventDefault()
      void openSettingsWindow()
      return
    }

    // Ctrl+Enter：在资源管理器中定位（不带 Shift）
    if (event.key === 'Enter' && event.ctrlKey && !event.shiftKey) {
      event.preventDefault()
      if (activeIndex >= 0) revealAt(activeIndex)
      return
    }

    // Ctrl+Shift+Enter：对当前问题做检索增强问答
    if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
      if (!query.trim()) return
      if (!settings.assistantEnabled) {
        setStatus('AI 文件助手未启用，请到 设置 → AI 与模型 打开')
        return
      }
      event.preventDefault()
      runAsk(query.trim())
      return
    }

    // 空格：开/关预览。Shift+Space 才输入真正的空格（多词查询用得上），
    // 中文输入法组合期间上面已提前返回，不会抢输入。
    if (event.key === ' ' && !event.shiftKey && !event.metaKey && !event.altKey) {
      if (event.repeat) return
      if (!previewOpen && !hits[activeIndex]) return
      event.preventDefault()
      if (isStale()) {
        setStatus('结果还在更新，稍等一下再预览')
        return
      }
      setPreviewOpen((open) => !open)
      return
    }

    if (target.closest('.preview') && event.key !== 'Escape') return

    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        // 先关面板，再关预览，最后才清空/隐藏
        if (ask) {
          setAsk(null)
          focusInput()
        } else if (previewOpen) {
          setPreviewOpen(false)
          focusResults()
        } else if (query) {
          updateQuery('')
          focusInput()
        } else {
          hide()
        }
        return
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        return
      case 'Enter':
        event.preventDefault()
        if (activeIndex >= 0) openAt(activeIndex)
        return
      default:
    }
  }

  async function togglePin() {
    const next = !settings.alwaysOnTop
    await setAlwaysOnTop(next)
    const updated = await patchSettings({ alwaysOnTop: next })
    setSettings(updated)
  }

  function toggleScope(root: string) {
    setScope((current) => (current === root ? null : root))
    focusInput()
  }

  const showNoResults = query.trim().length > 0 && hits.length === 0
  const showEmptyIndex = query.trim().length === 0 && hits.length === 0 && index.files === 0 && index.state !== 'scanning'

  // 结果与查询是否对得上：防抖期间旧结果还在，不能拿来打开
  const isStale = () => query.trim() + '|' + (scope ?? '') !== resultsKey
  // 无结果时只陈述"确实知道"的原因，其余落回通用提示
  const noResultReason: NoResultReason =
    index.state === 'scanning'
      ? 'scanning'
      : !settings.contentIndex
        ? 'content-off'
        : scope
          ? 'scoped'
          : 'generic'

  return (
    <main
      className="shell launcher"
      data-phase={phase}
      data-preview={previewFile ? 'true' : 'false'}
      data-onboarding={onboardingOpen ? 'true' : undefined}
      onAnimationEnd={onAnimationEnd}
      onKeyDown={onKeyDown}
    >
      <div inert={onboardingOpen} style={{ display: "contents" }}>
      <BrandBar
        pinned={settings.alwaysOnTop}
        desktop={isDesktop}
        onTogglePin={() => void togglePin()}
        onOpenSettings={() => void openSettingsWindow()}
        onClose={hide}
      />

      <section className="workspace">
        <SearchField
          inputRef={inputRef}
          value={query}
          hotkey={effectiveHotkey}
          busy={searching}
          onChange={updateQuery}
          onClear={() => {
            updateQuery('')
            focusInput()
          }}
        />

        <div className="content">


          {!ask && (<div className="filters" role="toolbar" aria-label="结果类型筛选">
            {scope && (
              <button
                type="button"
                className="chip chip--active"
                title={`清除目录限制：${scope}`}
                onClick={() => {
                  setScope(null)
                  focusInput()
                }}
              >
                范围：{scope.split(/[\\/]/).filter(Boolean).pop()}
                <X size={11} strokeWidth={2.2} />
              </button>
            )}
            {previewOpen ? (
              <span className="filters__label">{query ? '搜索结果' : '最近使用'}</span>
            ) : (
              TYPE_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={settings.typeFilter === item.id}
                title={`只看${item.label}`}
                onClick={() => {
                  void patchSettings({ typeFilter: item.id }).then(setSettings)
                  focusInput()
                }}
              >
                {item.label}
              </button>
              ))
            )}
            <span className="filters__meta">
              <b>{hits.length} 项</b>
              <span>·</span>
              <span>
                {settings.sortMode === 'recent'
                  ? '按修改时间'
                  : settings.sortMode === 'name'
                    ? '按名称'
                    : settings.sortMode === 'size'
                      ? '按大小'
                      : '按相关度'}
              </span>
            </span>
          </div>)}

          {ask ? (
            <AskPanel
              question={ask.question}
              answer={ask.answer}
              loading={ask.loading}
              error={ask.error}
              onClose={() => setAsk(null)}
              onOpenSource={(path) => {
                const hit = hits.find((item) => item.path === path)
                if (hit) openAt(hits.indexOf(hit))
                else setStatus('该来源不在当前结果里，可先搜索文件名再打开')
              }}
            />
          ) : showEmptyIndex ? (
            <EmptyIndex
              onScan={() => void startIndex()}
              onOpenSettings={() => void openSettingsWindow()}
            />
          ) : showNoResults ? (
            <NoResults
              query={query}
              reason={noResultReason}
              onSearchAll={() => {
                setScope(null)
                focusInput()
              }}
              onEnableContent={() => {
                void patchSettings({ contentIndex: true }).then((next) => {
                  setSettings(next)
                  setStatus('已开启正文索引，正在后台建立…')
                })
              }}
              onOpenSettings={() => void openSettingsWindow()}
            />
          ) : (
            <>
              {newHits && (
                <button
                  type="button"
                  className="results-banner"
                  onClick={() => {
                    const index = hits.findIndex((hit) => hit.path === newHits.first)
                    if (index >= 0) {
                      setActiveIndex(index)
                      document.getElementById(`result-${index}`)?.scrollIntoView({ block: 'nearest' })
                    }
                    setNewHits(null)
                  }}
                >
                  新增 {newHits.count} 条相关结果
                </button>
              )}
              <ResultsList
              files={hits}
              activeIndex={activeIndex}
              stale={isStale()}
              query={query}
              onSelect={(index) => {
                setActiveIndex(index)
                focusResults()
              }}
              onActivate={(index) => {
                openAt(index)
                focusInput()
              }}
              onPreview={(index) => {
                if (isStale()) {
                  setStatus('结果还在更新，稍等一下再预览')
                  return
                }
                setActiveIndex(index)
                setPreviewOpen(true)
                focusResults()
              }}
              roots={settings.roots}
            />
            </>
          )}
          {!query && (
            <QuickActions
              roots={settings.roots}
              scope={scope}
              onToggleScope={toggleScope}
              onOpenSettings={() => void openSettingsWindow()}
            />
          )}
        </div>

        <PreviewDrawer
          file={previewFile}
          query={query}
          onClose={() => {
            setPreviewOpen(false)
            focusResults()
          }}
          onOpen={(file) => {
            const index = hits.findIndex((hit) => hit.path === file.path)
            if (index >= 0) openAt(index)
          }}
          onReveal={(file) => {
            const index = hits.findIndex((hit) => hit.path === file.path)
            if (index >= 0) revealAt(index)
          }}
        />
      </section>

      <StatusBar
        query={query}
        total={hits.length}
        hotkey={effectiveHotkey}
        hotkeyActive={hotkeyActive}
        hotkeyFallback={hotkeyFallback}
        desktop={isDesktop}
        index={index}
        status={status}
        updateVersion={update?.latest ?? null}
        onOpenSettings={() => void openSettingsWindow()}
        onOpenUpdate={() => {
          if (update) void openUrl(update.url)
        }}
      />

      </div>
      {onboardingOpen && (
        <Onboarding
          settings={settings}
          hotkey={effectiveHotkey}
          onDone={(next, skipped) => {
            setSettings(next)
            setStatus(next.roots.length === 0
              ? '可在设置中添加索引目录'
              : skipped ? '' : '可在状态栏查看索引进度')
            focusInput()
          }}
        />
      )}
    </main>
  )
}
