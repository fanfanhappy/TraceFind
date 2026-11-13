// 在隔离实例上拍 README 用的界面截图。
// 前置：tools/capture-screens.ps1 已用假语料启动实例。
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9225'
const OUT = process.argv[3] ?? 'docs/screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) throw new Error('找不到窗口页面')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (!msg.id || !pending.has(msg.id)) return
  const p = pending.get(msg.id)
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
const ev = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
    .result?.value

const shoot = async (name) => {
  await sleep(500)
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const target = path.join(OUT, name)
  fs.writeFileSync(target, Buffer.from(data, 'base64'))
  console.log('saved', name)
}

const type = async (text) => {
  await ev(`(() => {
    const input = document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(900)
}

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(800)
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await sleep(300)

// 1) 搜索结果
await type('预算')
await shoot('01-search.png')

// 2) 预览（docx）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 2 })
await sleep(1200)
await shoot('02-preview.png')

// 关掉预览，拍空状态
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(400)

ws.close()
