// 等 OCR 正文入库，确认结果行带「OCR」标签，并截图
import fs from 'node:fs'
import path from 'node:path'

const [PORT = '9228', OUT = 'docs/screens'] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let targets = null
for (let i = 0; i < 80 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  } catch {
    await sleep(250)
  }
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (!m.id || !pending.has(m.id)) return
  const p = pending.get(m.id)
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
await send('Page.enable')
await send('Runtime.enable')
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result
    ?.value
const call = async (cmd, args = {}) =>
  ev(`(async () => {
    try { return JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})) }
    catch (error) { return 'ERR ' + String(error) }
  })()`)

const type = async (text) =>
  ev(`(() => {
    const input = document.querySelector('.searchfield input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(800)

// 最多等 90 秒：OCR 入库后「报价单」应该能搜到
let tagged = null
for (let i = 0; i < 45; i++) {
  const raw = await call('search_files', { query: '分两期', scope: null, limit: 5 })
  if (raw && !String(raw).startsWith('ERR')) {
    const hits = JSON.parse(raw)
    const hit = hits.find((item) => (item.sources ?? []).includes('ocr'))
    if (hit) {
      tagged = hit
      break
    }
  }
  await sleep(2000)
}
if (!tagged) {
  console.log('未等到 OCR 结果')
  process.exit(2)
}
console.log('ocr hit:', tagged.name, JSON.stringify(tagged.sources))

await type('分两期')
await sleep(1200)
const shown = await ev(`(() => {
  const tag = document.querySelector('.result__tag')
  const name = document.querySelector('.result__name')?.textContent ?? ''
  return JSON.stringify({ tag: tag?.textContent ?? null, name })
})()`)
console.log('dom:', shown)

// 截图前确保窗口处于可见相位（避免拍到进出场动画）
await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(900)
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)
await sleep(300)

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
fs.writeFileSync(path.join(OUT, '12-ocr-tag.png'), Buffer.from(data, 'base64'))
console.log('saved 12-ocr-tag.png')
ws.close()
