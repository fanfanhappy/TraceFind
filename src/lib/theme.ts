import { useEffect, useState } from 'react'
import { setWindowDark, type ThemePreference } from './bridge'

/** 系统当前的深浅色偏好 */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 把「深色 / 浅色 / 跟随系统」解析成确定的深色布尔值 */
export function resolveDark(preference: ThemePreference): boolean {
  if (preference === 'system') return systemPrefersDark()
  return preference === 'dark'
}

/**
 * 深浅主题 + 动效偏好的落地：统一写 documentElement 的 data-* 属性，
 * 同时把解析后的明暗同步给 Rust，让原生材质和界面用同一套明暗。
 */
export function useTheme(preference: ThemePreference, reducedMotion: boolean) {
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.dataset.motion = reducedMotion ? 'reduced' : 'full'
    root.style.colorScheme = resolved
    void setWindowDark(resolved === 'dark')
  }, [resolved, reducedMotion])

  return resolved
}

export function applyMaterial(mode: 'mica' | 'acrylic' | 'solid') {
  document.documentElement.dataset.material = mode
}
