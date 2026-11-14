// 验证两个 P1 行为（对着隔离实例跑）：
//  1) 改词后立刻按 Enter，不应打开旧结果
//  2) Esc 先关预览，再清空搜索
import fs from 'node:fs'

const PORT = Number(process.argv[2] ?? 9227)
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

const key = async (k, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}

const type = async (text) =>
  ev(`(() => {
    const input = document.querySelector('.searchfield input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    return input.value
  })()`)

const result = { stale: null, statusAfterEnter: null, drawerAfterCtrlSpace: null, esc1: null, esc2: null }

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(800)
await type('预算')
await sleep(900)
result.firstList = await ev(`document.querySelectorAll('.result').length`)

// 改成「会议」后 30ms 内按 Enter：debounce(45ms) 还没触发，旧结果仍在
await type('会议')
await sleep(30)
result.stale = await ev(`document.getElementById('results')?.dataset.stale ?? 'false'`)
await key('Enter', 'Enter', 13)
await sleep(150)
result.statusAfterEnter = await ev(`document.querySelector('.statusbar [role="status"]')?.textContent ?? ''`)
result.openedWhileStale = !(await ev(`!!document.querySelector('.drawer')`))

// 等新结果到达，Ctrl+Space 打开预览
await sleep(800)
await key(' ', 'Space', 32, 2)
await sleep(500)
result.drawerAfterCtrlSpace = await ev(`!!document.querySelector('.drawer')`)

// Esc #1：只关预览，查询保留
await key('Escape', 'Escape', 27)
await sleep(400)
result.esc1 = {
  drawer: await ev(`!!document.querySelector('.drawer')`),
  query: await ev(`document.querySelector('.searchfield input')?.value ?? ''`),
}

// Esc #2：清空查询
await key('Escape', 'Escape', 27)
await sleep(400)
result.esc2 = { query: await ev(`document.querySelector('.searchfield input')?.value ?? ''`) }

console.log(JSON.stringify(result, null, 2))
ws.close()
