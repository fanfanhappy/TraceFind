import path from 'node:path'
// 实测“唤起 → 可交互”延迟：反复 toggle，从日志取时间戳。
// 说明书 08 的性能目标是 P95 < 150ms（已运行状态下）。

import fs from 'node:fs'

const PORT = process.argv[2] ?? '9223'
const LOG =
  process.argv[3] ?? 'C:\\Users\\demo\\AppData\\Local\\com.tracefind.desktop\\logs\\tracefind.log'
const ROUNDS = Number(process.argv[4] ?? 20)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find(
  (t) => t.type === 'page' && (t.url.includes('tauri.localhost') || t.url.includes('127.0.0.1')),
)
if (!page) throw new Error('找不到窗口页面目标')

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

await send('Runtime.enable')
const invoke = (cmd) =>
  send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)})`,
    awaitPromise: true,
    returnByValue: true,
  })

// 冷启动数据取“本次测量之前”的启动日志
const initialLog = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''

for (let i = 0; i < ROUNDS; i += 1) {
  await invoke('hide_launcher')
  await sleep(420)
  await invoke('show_launcher')
  await sleep(420)
}
await invoke('hide_launcher')
await sleep(400)

const logText = fs.readFileSync(LOG, 'utf8')
const stamp = (line) => {
  const match = typeof line === 'string' ? line.match(/\[\+(\d+)ms\]/) : null
  return match ? Number(match[1]) : null
}

/* 冷启动：从进程启动到窗口首次可交互 */
const bootLines = initialLog.split(/\r?\n/)
const bootStart = stamp(bootLines.find((l) => l.includes('AURA Search 启动')))
const bootShown = stamp(bootLines.find((l) => l.includes('窗口已显示（可交互）')))
const coldStartMs = bootStart !== null && bootShown !== null ? bootShown - bootStart : null

/* 热唤起：每次 唤起 → 已显示，以及 已显示 → 动画结束 */
const lines = logText.split(/\r?\n/)
const realKeyStarts = []
const realKeySamples = []
const showSamples = []
const animSamples = []
let start = null
let shown = null

let pendingRealKey = null

for (const line of lines) {
  const at = stamp(line)

  if (line.includes('全局快捷键触发（真实按键）')) {
    // 真实按键路径：从 OS 回调开始计时，比 invoke 更接近用户感知
    pendingRealKey = at
    realKeyStarts.push(at)
  }

  if (line.includes('唤起：开始定位并显示窗口')) {
    start = at
    shown = null
  } else if (line.includes('窗口已显示（可交互）')) {
    if (start !== null && at !== null) {
      shown = at
      showSamples.push(shown - start)
    }
    if (pendingRealKey !== null && at !== null) {
      realKeySamples.push(at - pendingRealKey)
      pendingRealKey = null
    }
  } else if (line.includes('唤起完成：窗口可交互') && shown !== null) {
    if (at !== null) animSamples.push(at - shown)
    start = null
    shown = null
  }
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null
  return { p50: pick(0.5), p95: pick(0.95), max: sorted.length ? sorted[sorted.length - 1] : null }
}

console.log(
  JSON.stringify(
    {
      rounds: showSamples.length,
      coldStartMs,
      showMs: { ...stats(showSamples), samples: showSamples },
      animationMs: { ...stats(animSamples), samples: animSamples },
      target: 'P95 < 150ms（快捷键 → 窗口可交互）',
      realKeyMs: realKeySamples.length ? { ...stats(realKeySamples), samples: realKeySamples } : null,
      note:
        'showMs = 触发唤起到窗口已显示；animationMs = 之后走完的 180ms 唤起动画（设计值）',
    },
    null,
    2,
  ),
)

ws.close()
