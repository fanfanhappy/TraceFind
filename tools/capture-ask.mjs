// 用真实云端接口跑一次问答并截图（仅假语料）。
// 参数：port outDir baseUrl apiKey model
import fs from 'node:fs'
import path from 'node:path'

const [PORT = '9225', OUT = 'docs/screens', BASE = '', KEY = '', MODEL = 'gpt-4o-mini'] = process.argv.slice(2)
if (!BASE || !KEY) throw new Error('缺少 baseUrl 或 apiKey')
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
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
const call = async (cmd, args = {}) =>
  ev(`(async () => {
    try { return JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})) }
    catch (error) { return 'ERR ' + String(error) }
  })()`)

const shoot = async (name) => {
  await sleep(400)
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
  console.log('saved', name)
}

const key = async (k, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(250)
}

// 配置云端问答（Key 只经 IPC 传给后端，由 DPAPI 加密存储）
console.log(await call('patch_settings', { patch: { assistantEnabled: true, cloudBaseUrl: BASE, assistantModel: MODEL } }))
console.log('key status:', await call('cloud_key_status'))
const saved = await call('patch_settings', { patch: { cloudApiKey: KEY } })
if (String(saved).startsWith('ERR')) throw new Error(String(saved))

await ev(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
await sleep(700)
await ev(`document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`)

const type = async (text) => {
  await ev(`(() => {
    const input = document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`)
  await sleep(600)
}

// 等正文索引就绪（有片段返回）再提问，否则检索会空
let ready = false
for (let i = 0; i < 40 && !ready; i++) {
  const raw = await call('search_files', { query: '预算', scope: null, limit: 5 })
  if (raw && !String(raw).startsWith('ERR')) {
    const hits = JSON.parse(raw)
    ready = hits.some((hit) => hit.snippet)
  }
  if (!ready) await sleep(1000)
}
console.log('content ready:', ready)

const question = '这份预算报告里，哪个科目超支了？'
await type(question)
await key('Enter', 'Enter', 13, 10) // Ctrl+Shift+Enter 提问（modifiers: 2=Ctrl, 8=Shift）

// 等答案出现（最多 90 秒）
let answer = null
for (let i = 0; i < 60; i++) {
  await sleep(1500)
  const text = await ev(`document.querySelector('.ask__answer')?.innerText ?? ''`)
  if (text && text.length > 8) {
    answer = text
    break
  }
  const err = await ev(`document.querySelector('.ask__error')?.innerText ?? ''`)
  if (err) throw new Error('问答失败：' + err)
}
if (!answer) throw new Error('等待答案超时')

console.log('answer:', answer.slice(0, 120).replace(/\s+/g, ' '))
await shoot('08-ai-ask.png')

// 展开第一条来源再拍一张
const opened = await ev(`(() => {
  const btn = document.querySelector('.ask__source-head')
  if (!btn) return 'missing'
  btn.click()
  return 'ok'
})()`)
console.log('source expand:', opened)
await sleep(500)
await shoot('09-ai-sources.png')

ws.close()
