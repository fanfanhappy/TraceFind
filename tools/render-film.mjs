// 逐帧渲染 docs/assets/promo-film.html → JPEG 序列
// 用法：node tools/render-film.mjs <port> <outDir> [fps] [duration]
import fs from 'node:fs'
import path from 'node:path'

const [PORT = '9333', OUT = 'release/promo/frames', FPS = '30', DURATION = '20', FILM_URL = ''] = process.argv.slice(2)
const fps = Number(FPS)
const duration = Number(DURATION)
const total = Math.round(fps * duration)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 等调试端口
let targets = null
for (let i = 0; i < 80 && !targets; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`)
    targets = await res.json()
  } catch {
    await wait(250)
  }
}
if (!targets) throw new Error('调试端口未就绪')

const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('找不到页面')

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

// headless 下只能有一个 target：先 about:blank，再由 CDP 导航到影片
if (FILM_URL) {
  await send('Page.navigate', { url: FILM_URL })
  for (let i = 0; i < 40; i++) {
    await wait(250)
    const ready = await send('Runtime.evaluate', {
      expression: `document.readyState === 'complete' && typeof window.__render === 'function'`,
      returnByValue: true,
    })
    if (ready.result?.value) break
  }
}
await send('Emulation.setDeviceMetricsOverride', {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
})
await wait(700)

const ev = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.value

const ready = await ev(`typeof window.__render === 'function'`)
if (!ready) throw new Error('页面脚本未就绪')

for (let index = 0; index < total; index++) {
  const t = index / fps
  await ev(`window.__render(${t.toFixed(3)})`)
  const { data } = await send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 92,
    fromSurface: true,
  })
  const file = path.join(OUT, `frame_${String(index).padStart(4, '0')}.jpg`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  if (index % 60 === 0) console.log(`frame ${index}/${total} (t=${t.toFixed(1)}s)`)
}

console.log(`done: ${total} frames -> ${OUT}`)
ws.close()
