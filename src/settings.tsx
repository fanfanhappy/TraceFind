import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/glass.css'
import './styles/app.css'
import './styles/animation.css'
import { Settings } from './windows/Settings'

// 首帧前铺好主题属性，避免设置窗口闪白
const root = document.documentElement
try {
  const raw = localStorage.getItem('aura-settings')
  const theme = raw ? (JSON.parse(raw) as { theme?: string }).theme : 'dark'
  const dark =
    theme === 'light'
      ? false
      : theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : true
  root.dataset.theme = dark ? 'dark' : 'light'
} catch {
  root.dataset.theme = 'dark'
}
root.dataset.material = 'solid'
root.dataset.motion = 'full'

createRoot(document.getElementById('root')!).render(<Settings />)
