// 抓取真实运行窗口（保持原生材质，不覆盖背景），用于核对浅色下的观感。
import fs from 'node:fs'

const PORT = process.argv[2] ?? '9223'
const OUT = process.argv[3] ?? 'shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function attach(page) {
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
  return { send, close: () => ws.close() }
}

const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json())

async function shot(match, theme, file) {
  const targets = await list()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(match) && !t.url.includes('settings.html'))
  if (!page) {
    console.log('missing', match)
    return
  }
  const client = await attach(page)
  await client.send('Runtime.evaluate', {
    expression: `document.documentElement.dataset.theme = '${theme}'`,
  })
  await sleep(500)
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  client.close()
  console.log('saved', file)
}

// 主窗口：浅色 / 深色
const mainTargets = await list()
const main = mainTargets.find((t) => t.url.includes('tauri.localhost/') && !t.url.includes('settings.html'))
if (main) {
  const client = await attach(main)
  await client.send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke('patch_settings', { patch: { theme: 'system' } })`,
    awaitPromise: true,
  })
  client.close()
  await sleep(600)
}

await shot('tauri.localhost/', 'light', `${OUT}/12-live-light-main.png`)

// 设置窗口（浅色）
{
  const targets = await list()
  const mainPage = targets.find((t) => t.url.includes('tauri.localhost/') && !t.url.includes('settings.html'))
  const client = await attach(mainPage)
  await client.send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke('open_settings')`,
    awaitPromise: true,
  })
  client.close()
  await sleep(2500)
}
await shot('settings.html', 'light', `${OUT}/13-live-light-settings.png`)

// 关闭设置窗口
{
  const targets = await list()
  const mainPage = targets.find((t) => t.url.includes('tauri.localhost/') && !t.url.includes('settings.html'))
  const client = await attach(mainPage)
  await client.send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke('close_settings')`,
    awaitPromise: true,
  })
  client.close()
}
