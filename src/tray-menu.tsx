import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { TrayMenu } from './components/TrayMenu'

const root = document.documentElement
root.dataset.theme = 'dark'
root.dataset.material = 'solid'
root.dataset.motion = 'full'

createRoot(document.getElementById('root')!).render(<TrayMenu />)