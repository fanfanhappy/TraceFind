// 抓取预览抽屉：文本命中定位 + 图片预览
import fs from 'node:fs'

const PORT = process.argv[2] ?? '9223'
const OUT = process.argv[3] ?? 'shots'
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

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

async function key(keyName, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sleep(200)
}

async function prepare() {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('show_launcher')`)
  await sleep(700)
  await evaluate(
    `document.documentElement.dataset.theme='dark'; document.documentElement.dataset.material='solid'; document.body.style.background='#17191F'`,
  )
}

async function typeQuery(text) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 92, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 92, button: 'left', clickCount: 1 })
  await sleep(120)
  await evaluate(`(() => {
    const input = document.querySelector('input')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'
  })()`)
  await sleep(200)
  await send('Input.insertText', { text })
  await sleep(600)
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  console.log('saved', name)
}

await prepare()

// 文本预览：搜「托盘」→ Tab 到列表 → Space 开预览
await typeQuery('托盘')
await key('Tab', 'Tab', 9)
await key(' ', 'Space', 32)
await sleep(900)
console.log('text preview:', JSON.stringify(await evaluate(`({
  drawer: !!document.querySelector('.preview'),
  marks: document.querySelectorAll('.preview__text mark').length,
  title: document.querySelector('.preview__title')?.textContent,
  bodyStart: document.querySelector('.preview__text')?.textContent?.slice(0, 40) ?? null,
})`)))
await shot('35-m5-preview-text.png')

// 图片预览
await key('Escape', 'Escape', 27)
await typeQuery('png')
await sleep(400)

// 只用键盘：点行会真的用外部程序打开文件，测试里不要点
const imageIndex = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[role=option]')]
  return rows.findIndex(r => r.querySelector('.result__icon')?.dataset.kind === 'image')
})()`)
console.log('image row index:', imageIndex)

if (imageIndex >= 0) {
  for (let i = 0; i < imageIndex; i += 1) await key('ArrowDown', 'ArrowDown', 40)
  await key('Tab', 'Tab', 9)
  await key(' ', 'Space', 32)
  await sleep(1200)
  console.log('image preview:', JSON.stringify(await evaluate(`({
    image: !!document.querySelector('.preview__image'),
    src: document.querySelector('.preview__image')?.src?.slice(0, 24) ?? null,
    title: document.querySelector('.preview__title')?.textContent ?? null,
  })`)))
  await shot('36-m5-preview-image.png')
} else {
  console.log('no image row found')
}

ws.close()
