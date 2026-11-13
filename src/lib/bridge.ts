// 桌面桥接层：把 Tauri 能力收敛成一组带类型的方法。
// 在纯浏览器（vite dev / 自动化检查）下自动降级为 localStorage + 模拟生命周期，
// 保证界面不依赖桌面环境即可运行与验证。

import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { demoHits, type SearchHit } from './files'

export const isDesktop = isTauri()

export type ThemePreference = 'dark' | 'light' | 'system'
export type MaterialMode = 'mica' | 'acrylic' | 'solid'
export type LauncherPhase = 'hidden' | 'showing' | 'visible' | 'hiding'

export interface AppSettings {
  onboardingComplete: boolean
  theme: ThemePreference
  reducedMotion: boolean
  hotkey: string
  autostart: boolean
  alwaysOnTop: boolean
  closeToTray: boolean
  resultLimit: number
  /** 打开文件后保持窗口可见（不因失焦自动隐藏） */
  keepOpenAfterOpen: boolean
  /** 索引扫描范围（绝对路径） */
  roots: string[]
  excludedPaths: string[]
  /** 是否建立正文索引（FTS） */
  contentIndex: boolean
  /** 是否启用语义检索（本地嵌入） */
  semanticEnabled: boolean
  /** 语义提供方：local | cloud */
  semanticProvider: 'local' | 'cloud'
  cloudBaseUrl: string
  cloudModel: string
  /** 用户是否已确认云端会收到文档片段 */
  cloudConsent: boolean
  /** 排序方式：relevance | recent | name | size */
  sortMode: 'relevance' | 'recent' | 'name' | 'size'
  /** 结果类型筛选 */
  typeFilter: 'all' | 'doc' | 'image' | 'code' | 'folder' | 'other'
  /** 是否用系统 OCR 识别图片与扫描件 PDF */
  ocrEnabled: boolean
  /** 是否启用 AI 文件助手（检索增强问答） */
  assistantEnabled: boolean
  /** 问答模型名 */
  assistantModel: string
  /** 仅用于写入：明文 Key，后端会 DPAPI 加密后落盘，不会回传 */
  cloudApiKey?: string
  aiEnabled: boolean
}

export interface RuntimeInfo {
  version: string
  platform: string
  material: MaterialMode
  hotkey: string
  hotkeyActive: boolean
  autostart: boolean
  dataDir: string
  phase?: LauncherPhase
  launcherVisible?: boolean
  /** 实时文件监听是否在运行 */
  watching?: boolean
  /** 设置里配置的快捷键（可能被占用） */
  hotkeyConfigured?: string
  /** 是否启用了兜底快捷键 */
  hotkeyFallback?: boolean
}

export const defaultSettings: AppSettings = {
  onboardingComplete: false,
  theme: 'dark',
  reducedMotion: false,
  hotkey: 'Alt+Space',
  autostart: false,
  alwaysOnTop: false,
  closeToTray: true,
  resultLimit: 8,
  keepOpenAfterOpen: true,
  roots: [],
  excludedPaths: [],
  contentIndex: true,
  semanticEnabled: false,
  semanticProvider: 'local',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudModel: 'text-embedding-3-small',
  cloudConsent: false,
  sortMode: 'relevance',
  typeFilter: 'all',
  ocrEnabled: true,
  assistantEnabled: false,
  assistantModel: 'gpt-4o-mini',
  aiEnabled: false,
}

export type IndexState = 'idle' | 'scanning' | 'paused' | 'ready' | 'demo'

export interface AskSource {
  path: string
  name: string
  snippet: string
}

export interface AskAnswer {
  answer: string
  sources: AskSource[]
  model: string
  chars: number
}

export interface CloudTestResult {
  ok: boolean
  dim: number
  ms: number
  model: string
}

export interface SemanticStatus {
  enabled: boolean
  provider: 'local' | 'cloud'
  /** disabled | idle | downloading | ready | error */
  state: string
  model: string
  chunks: number
  vectors: number
  message: string | null
}

export interface PreviewPayload {
  kind: 'text' | 'image' | 'folder' | 'unsupported' | 'error'
  name: string
  path: string
  ext: string
  size: number
  modified: number
  text: string | null
  truncated: boolean
  totalChars: number | null
  /** 下一页起始位置；null 表示已到底 */
  nextStart: number | null
  imageDataUrl: string | null
  language: string | null
  message: string | null
}

export interface ContentStatus {
  done: number
  failed: number
  chars: number
  pending: number
  enabled: boolean
}

export interface IndexStatus {
  state: IndexState
  files: number
  scanned: number
  current: string
  lastScan: number
  error: string | null
}

const STORAGE_KEY = 'aura-settings'
const HOTKEY_EVENT = 'aura:hotkey-conflict'

function readLocalSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultSettings }
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    return { ...defaultSettings }
  }
}

function writeLocalSettings(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export async function loadSettings(): Promise<AppSettings> {
  if (!isDesktop) return readLocalSettings()
  try {
    return await invoke<AppSettings>('get_settings')
  } catch {
    return { ...defaultSettings }
  }
}

export async function suggestedRoots(): Promise<string[]> {
  return isDesktop ? invoke<string[]>('suggested_roots') : []
}

export async function completeOnboarding(roots: string[]): Promise<AppSettings> {
  return isDesktop
    ? invoke<AppSettings>('complete_onboarding', { roots })
    : patchSettings({ roots, onboardingComplete: true, contentIndex: false, ocrEnabled: false })
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (!isDesktop) {
    const next = { ...readLocalSettings(), ...patch }
    writeLocalSettings(next)
    return next
  }
  return await invoke<AppSettings>('patch_settings', { patch })
}

/** 注册全局快捷键；冲突时返回 ok:false 与冲突的组合键，旧快捷键保持不变。 */
export async function applyHotkey(accel: string): Promise<{ ok: boolean; conflict?: string; settings?: AppSettings }> {
  if (!isDesktop) {
    const next = { ...readLocalSettings(), hotkey: accel }
    writeLocalSettings(next)
    return { ok: true, settings: next }
  }
  return await invoke<{ ok: boolean; conflict?: string; settings?: AppSettings }>('apply_hotkey', { accel })
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (!isDesktop) {
    const settings = readLocalSettings()
    return {
      version: '0.1.0',
      platform: '浏览器预览',
      material: 'solid',
      hotkey: settings.hotkey,
      hotkeyActive: false,
      autostart: settings.autostart,
      dataDir: '—',
    }
  }
  try {
    return await invoke<RuntimeInfo>('get_runtime_info')
  } catch {
    return {
      version: '0.1.0',
      platform: 'Windows',
      material: 'solid',
      hotkey: readLocalSettings().hotkey,
      hotkeyActive: false,
      autostart: false,
      dataDir: '—',
    }
  }
}

/* ------------------------------------------------------------ 窗口行为 */

export async function showLauncher() {
  if (isDesktop) await invoke('show_launcher').catch(() => {})
}

export async function hideLauncher() {
  if (isDesktop) await invoke('hide_launcher').catch(() => {})
}

export async function openSettingsWindow() {
  if (isDesktop) {
    await invoke('open_settings').catch(() => {})
    return
  }
  window.open(`${location.origin}/settings.html`, '_blank', 'width=900,height=640')
}

export async function closeSettingsWindow() {
  if (isDesktop) await invoke('close_settings').catch(() => {})
  else window.close()
}

export async function setAlwaysOnTop(value: boolean) {
  if (!isDesktop) return
  await getCurrentWindow().setAlwaysOnTop(value).catch(() => {})
}

export async function startDrag() {
  if (!isDesktop) return
  await getCurrentWindow().startDragging().catch(() => {})
}

export async function quitApp() {
  if (isDesktop) await invoke('quit_app').catch(() => {})
}

/** 通知 Rust：前端视觉动画已结束，可以执行原生 hide。 */
export async function notifyAnimationFinished(phase: 'show' | 'hide') {
  if (isDesktop) await invoke('launcher_animation_finished', { phase }).catch(() => {})
}

/** 用户主动隐藏（Esc / 再次按快捷键）：交给状态机走动画 + 原生 hide。 */
export async function requestHide() {
  if (isDesktop) await invoke('hide_launcher').catch(() => {})
}

export async function requestToggle() {
  if (isDesktop) await invoke('toggle_launcher').catch(() => {})
}

/**
 * 告诉 Rust 窗口材质该用深色还是浅色版本。
 * Mica/Acrylic 的明暗由系统绘制，必须和解析后的实际主题一致；
 * 不传这个值就会出现“浅色界面 + 深色 Mica”的发灰观感。
 */
export async function setWindowDark(dark: boolean) {
  if (isDesktop) await invoke('set_window_dark', { dark }).catch(() => {})
}

/**
 * 前端挂载完成的握手信号。
 * Rust 侧在收到它之后才把主窗口从 visible:false 切到可见并派发 launcher:show，
 * 避免 WebView 首帧白屏。
 */
export async function frontendReady() {
  if (isDesktop) await invoke('frontend_ready').catch(() => {})
}

/* ------------------------------------------------------------ 事件订阅 */

export function onLauncherShow(cb: () => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen('launcher:show', () => cb()).then(fn => (un = fn))
  return () => un?.()
}

export function onLauncherHide(cb: () => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen('launcher:hide', () => cb()).then(fn => (un = fn))
  return () => un?.()
}

export function onLauncherFocus(cb: () => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen('launcher:focus', () => cb()).then(fn => (un = fn))
  return () => un?.()
}

/** 设置窗口修改设置后，主窗口即时同步（跨窗口一致性） */
export function onSettingsChanged(cb: (settings: AppSettings) => void): () => void {
  if (!isDesktop) {
    const handler = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) cb(readLocalSettings())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }
  let un: UnlistenFn | undefined
  void listen<AppSettings>('aura:settings-changed', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

/** 配置的快捷键被占用、已自动降级时广播 */
export function onHotkeyFallback(
  cb: (payload: { configured: string; active: string }) => void,
): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<{ configured: string; active: string }>('aura:hotkey-fallback', event =>
    cb(event.payload),
  ).then(fn => (un = fn))
  return () => un?.()
}

export function onHotkeyConflict(cb: (accel: string) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<string>(HOTKEY_EVENT, event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

/** 快捷键重新注册成功后广播，主窗口据此清除冲突提示 */
export function onHotkeyRegistered(cb: (accel: string) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<string>('aura:hotkey-ok', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

/* ------------------------------------------------------------ 文件动作 */

/** 打开文件前调用：hold=true 时窗口不会因为失焦而隐藏 */
export async function setHoldVisible(hold: boolean) {
  if (isDesktop) await invoke('set_hold_visible', { hold }).catch(() => {})
}

/**
 * 打开文件（保持窗口与否由后端在同一次调用里先设标志再拉起系统程序）。
 * 返回系统是否真的把打开请求发出去了，前端据此显示成功/失败。
 */
export async function openFileHold(
  path: string,
  hold: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!isDesktop) return { ok: false, error: '浏览器预览无法打开本地文件' }
  try {
    await invoke('open_path_hold', { path, hold })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function openFile(path: string) {
  if (isDesktop) await invoke('open_path', { path }).catch(() => {})
}

export async function revealFile(path: string) {
  if (isDesktop) await invoke('reveal_path', { path }).catch(() => {})
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 索引与搜索 */

/** 浏览器预览没有后端：用演示数据模拟同样的接口形状 */
function demoSearch(query: string, scope: string | null, limit: number): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return demoHits
    .filter(hit => {
      if (scope && !hit.path.toLowerCase().startsWith(scope.toLowerCase())) return false
      const haystack = `${hit.name} ${hit.dir}`.toLowerCase()
      return terms.every(term => haystack.includes(term))
    })
    .slice(0, limit)
}

export async function searchFiles(
  query: string,
  scope: string | null = null,
  limit = 30,
): Promise<SearchHit[]> {
  if (!isDesktop) return demoSearch(query, scope, limit)
  try {
    return await invoke<SearchHit[]>('search_files', { query, scope, limit })
  } catch {
    return []
  }
}

export async function recentFiles(scope: string | null = null, limit = 5): Promise<SearchHit[]> {
  if (!isDesktop) return demoSearch('', scope, limit).length ? demoHits.slice(0, limit) : []
  try {
    return await invoke<SearchHit[]>('recent_files', { scope, limit })
  } catch {
    return []
  }
}

export async function getIndexStatus(): Promise<IndexStatus> {
  if (!isDesktop) {
    return { state: 'demo', files: demoHits.length, scanned: 0, current: '', lastScan: 0, error: null }
  }
  try {
    return await invoke<IndexStatus>('index_status')
  } catch {
    return { state: 'idle', files: 0, scanned: 0, current: '', lastScan: 0, error: null }
  }
}

export async function getContentStatus(): Promise<ContentStatus> {
  if (!isDesktop) return { done: 0, failed: 0, chars: 0, pending: 0, enabled: false }
  try {
    return await invoke<ContentStatus>('content_status')
  } catch {
    return { done: 0, failed: 0, chars: 0, pending: 0, enabled: false }
  }
}

/** 预览数据：文本/Office/PDF 走抽取器，图片返回 data URL */
export async function previewFile(
  path: string,
  start = 0,
): Promise<PreviewPayload | null> {
  if (!isDesktop) {
    const hit = demoHits.find((item) => item.path === path)
    if (!hit) return null
    return {
      kind: 'unsupported',
      name: hit.name,
      path: hit.path,
      ext: hit.ext,
      size: hit.size,
      modified: hit.modified,
      text: null,
      truncated: false,
      totalChars: null,
  nextStart: null,
      imageDataUrl: null,
      language: null,
      message: '浏览器预览没有本地文件访问权限',
    }
  }
  try {
    return await invoke<PreviewPayload>('preview_file', { path, start })
  } catch {
    return null
  }
}

export async function getSemanticStatus(): Promise<SemanticStatus> {
  if (!isDesktop) return { enabled: false, state: 'disabled', provider: 'local', model: '', chunks: 0, vectors: 0, message: null }
  try {
    return await invoke<SemanticStatus>('semantic_status')
  } catch {
    return { enabled: false, state: 'disabled', provider: 'local', model: '', chunks: 0, vectors: 0, message: null }
  }
}

export async function setSemantic(enabled: boolean): Promise<AppSettings> {
  return await invoke<AppSettings>('set_semantic', { enabled })
}

export async function rebuildSemantic(): Promise<boolean> {
  if (!isDesktop) return false
  try {
    return await invoke<boolean>('rebuild_semantic')
  } catch {
    return false
  }
}

export async function testCloudEmbedding(payload: {
  baseUrl?: string
  model?: string
  apiKey?: string
}): Promise<CloudTestResult> {
  if (!isDesktop) throw new Error('仅桌面端可用')
  return await invoke<CloudTestResult>('test_cloud_embedding', {
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  })
}

/** 语义结果异步补发：先返回本地结果，云端/本地语义稍后到达 */
export function onSemanticHits(
  cb: (payload: { query: string; hits: SearchHit[] }) => void,
): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<{ query: string; hits: SearchHit[] }>('search:semantic', event =>
    cb(event.payload),
  ).then(fn => (un = fn))
  return () => un?.()
}

/** 检索增强问答：基于本地检索到的正文片段调用云端模型 */
export async function askFiles(
  question: string,
  scope: string | null = null,
): Promise<AskAnswer> {
  return await invoke<AskAnswer>('ask_files', { question, scope })
}

export async function cloudKeyStatus(): Promise<boolean> {
  if (!isDesktop) return false
  try {
    return await invoke<boolean>('cloud_key_status')
  } catch {
    return false
  }
}

export function onSemanticStatus(cb: (status: SemanticStatus) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<SemanticStatus>('semantic:status', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

export async function rebuildContent(): Promise<boolean> {
  if (!isDesktop) return false
  try {
    return await invoke<boolean>('rebuild_content')
  } catch {
    return false
  }
}

export function onContentProgress(cb: (status: ContentStatus) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<ContentStatus>('index:content', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

export async function startIndex(): Promise<boolean> {
  if (!isDesktop) return false
  try {
    return await invoke<boolean>('start_index')
  } catch {
    return false
  }
}

export async function pauseIndex() {
  if (isDesktop) await invoke('pause_index').catch(() => {})
}

export async function resumeIndex() {
  if (isDesktop) await invoke('resume_index').catch(() => {})
}

export async function addRoot(path: string): Promise<AppSettings> {
  if (!isDesktop) {
    const next = { ...readLocalSettings(), roots: [...readLocalSettings().roots, path] }
    writeLocalSettings(next)
    return next
  }
  return await invoke<AppSettings>('add_root', { path })
}

export async function removeRoot(path: string): Promise<AppSettings> {
  if (!isDesktop) {
    const next = { ...readLocalSettings(), roots: readLocalSettings().roots.filter(root => root !== path) }
    writeLocalSettings(next)
    return next
  }
  return await invoke<AppSettings>('remove_root', { path })
}

/** 增量更新：文件系统变化被写入索引后广播 */
export function onIndexChanged(cb: (payload: { files: number; changed: number }) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<{ files: number; changed: number }>('index:changed', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}

export function onIndexProgress(cb: (status: IndexStatus) => void): () => void {
  if (!isDesktop) return () => {}
  let un: UnlistenFn | undefined
  void listen<IndexStatus>('index:progress', event => cb(event.payload)).then(fn => (un = fn))
  return () => un?.()
}
