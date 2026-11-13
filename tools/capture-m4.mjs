// 抓取正文命中的界面效果：搜索一个只出现在文档正文里的词
import fs from 'node:fs'

const PORT = process.argv[2] ?? '9223'
const OUT = process.argv[3] ?? 'shots'
const QUERY = process.argv[4] ?? '托盘'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
await send('Page.enable')
await send('Runtime.enable')

await send('Runtime.evaluate', {
  expression: `window.__TAURI_INTERNALS__.invoke('show_launcher')`,
  awaitPromise: true,
})
await sleep(700)
await send('Runtime.evaluate', {
  expression: `document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`,
})
await sleep(300)

// 点击搜索框并真实输入
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 92, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 92, button: 'left', clickCount: 1 })
await send('Input.insertText', { text: QUERY })
await sleep(900)

const info = await send('Runtime.evaluate', {
  expression: `({
    rows: document.querySelectorAll('[role=option]').length,
    snippets: document.querySelectorAll('.result__snippet').length,
    first: document.querySelector('.result__snippet')?.textContent ?? null,
  })`,
  returnByValue: true,
})
console.log(JSON.stringify(info.result.value))

const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
fs.writeFileSync(`${OUT}/34-m4-content-search.png`, Buffer.from(data, 'base64'))
console.log('saved 34-m4-content-search.png')
ws.close()
